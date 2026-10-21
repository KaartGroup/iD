import fetchMock from 'fetch-mock';
import { PbfWriter } from 'pbf';
import { select as d3_select } from 'd3-selection';
import { dispatch as d3_dispatch } from 'd3-dispatch';
import { setTimeout } from 'node:timers/promises';


// ---------------------------------------------------------------------------
// Minimal Mapbox Vector Tile encoder, so that the service is tested against
// real MVT bytes decoded by the real `@mapbox/vector-tile` reader.
// Field numbers are from the vector_tile.proto of the MVT 2.1 specification:
// https://github.com/mapbox/vector-tile-spec/blob/master/2.1/vector_tile.proto
// ---------------------------------------------------------------------------
const EXTENT = 4096;

function zigzag(n) {
    return (n << 1) ^ (n >> 31);
}

function command(id, count) {
    return (id & 0x7) | (count << 3);
}

/** lon/lat → fractional tile coordinates at zoom `z` (web mercator) */
function lonLatToTile([lon, lat], z) {
    const n = Math.pow(2, z);
    const latRad = lat * Math.PI / 180;
    return [
        (lon + 180) / 360 * n,
        (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
    ];
}

function encodeGeometry(type, coords, [tx, ty, z]) {
    const points = coords.map(loc => {
        const [x, y] = lonLatToTile(loc, z);
        return [Math.round((x - tx) * EXTENT), Math.round((y - ty) * EXTENT)];
    });
    const geometry = [];
    let cx = 0, cy = 0;
    points.forEach(([x, y], i) => {
        if (i === 0) geometry.push(command(1, 1));                         // MoveTo
        if (i === 1) geometry.push(command(2, points.length - 1));         // LineTo
        geometry.push(zigzag(x - cx), zigzag(y - cy));
        cx = x;
        cy = y;
    });
    return { type: type === 'Point' ? 1 : 2, geometry };
}

function writeValue(value, pbf) {
    if (typeof value === 'string') pbf.writeStringField(1, value);
    else if (typeof value === 'boolean') pbf.writeBooleanField(7, value);
    else if (Number.isInteger(value) && value >= 0) pbf.writeVarintField(5, value);
    else if (Number.isInteger(value)) pbf.writeSVarintField(6, value);
    else pbf.writeDoubleField(3, value);
}

function writeLayer(layer, pbf) {
    const keys = [];
    const values = [];
    const keyIndex = new Map();
    const valueIndex = new Map();

    pbf.writeVarintField(15, 2);                 // version
    pbf.writeStringField(1, layer.name);         // name

    for (const feature of layer.features) {
        const tags = [];
        for (const [key, value] of Object.entries(feature.properties)) {
            if (value === undefined) continue;
            if (!keyIndex.has(key)) {
                keyIndex.set(key, keys.length);
                keys.push(key);
            }
            const valueKey = typeof value + ':' + value;
            if (!valueIndex.has(valueKey)) {
                valueIndex.set(valueKey, values.length);
                values.push(value);
            }
            tags.push(keyIndex.get(key), valueIndex.get(valueKey));
        }
        const { type, geometry } = encodeGeometry(feature.type, feature.coordinates, layer.tile);
        pbf.writeMessage(2, (_, p) => {        // features
            p.writePackedVarint(2, tags);
            p.writeVarintField(3, type);
            p.writePackedVarint(4, geometry);
        }, null);
    }

    keys.forEach(key => pbf.writeStringField(3, key));
    values.forEach(value => pbf.writeMessage(4, writeValue, value));
    pbf.writeVarintField(5, EXTENT);
}

/**
 * @param {number[]} tile [x, y, z]
 * @param {Object<string, Array>} layers layer name → features
 * @returns {Uint8Array} the encoded vector tile
 */
function encodeTile(tile, layers) {
    const pbf = new PbfWriter();
    for (const [name, features] of Object.entries(layers)) {
        pbf.writeMessage(3, writeLayer, { name, features, tile });
    }
    return pbf.finish();
}


describe('iD.serviceMaprizon', function() {
    const dimensions = [512, 512];
    const tileHost = 'https://maprizon-id.sfo3.cdn.digitaloceanspaces.com/';
    const z15Tile = [17066, 11538, 15];
    const z10Tile = [533, 360, 10];
    const z15Url = tileHost + '15/17066/11538.mvt';
    const z10Url = tileHost + '10/533/360.mvt';
    const center = [7.4955, 46.9];

    // a flat sequence with pictures 0, 1, 2 and 4: picture 3 is not published
    const sequencePictures = [0, 1, 2, 4].map(index => ({
        type: 'Point',
        coordinates: [[7.4935 + index * 0.001, 46.9]],
        properties: {
            id: 'pic-' + index,
            ts: `2024-05-01T08:00:0${index}Z`,
            first_sequence: 'seq-a',
            sequence_index: index,
            heading: 87.5,
            type: 'flat',
            url: `https://images.example.com/seq-a/${index}.jpg`
        }
    }));
    // a lone 360° still, without a sequence
    const lonePicture = {
        type: 'Point',
        coordinates: [[7.4955, 46.9005]],
        properties: {
            id: 'still-1',
            ts: '2023-01-15T12:00:00Z',
            sequence_index: 0,
            heading: 270,
            type: 'equirectangular',
            url: 'https://images.example.com/still-1.jpg'
        }
    };
    const sequenceA = {
        type: 'LineString',
        coordinates: [[7.4935, 46.9], [7.4975, 46.9]],
        properties: { id: 'seq-a', type: 'flat', date: '2024-05-01' }
    };
    const sequenceB = {
        type: 'LineString',
        coordinates: [[7.40, 46.95], [7.42, 46.96]],
        properties: { id: 'seq-b', type: 'equirectangular', date: '2022-03-03' }
    };

    const z15Bytes = encodeTile(z15Tile, {
        sequences: [sequenceA],
        pictures: [...sequencePictures, lonePicture]
    });
    const z10Bytes = encodeTile(z10Tile, {
        sequences: [sequenceA, sequenceB]
    });

    function mvtResponse(bytes) {
        return () => new Response(bytes, {
            status: 200,
            headers: { 'Content-Type': 'application/vnd.mapbox-vector-tile' }
        });
    }

    let context, maprizon, consoleError;

    function centerOn(loc, zoom) {
        context.projection
            .scale(iD.geoZoomToScale(zoom))
            .translate([0, 0])
            .clipExtent([[0, 0], dimensions]);
        const p = context.projection(loc);
        context.projection.translate([dimensions[0] / 2 - p[0], dimensions[1] / 2 - p[1]]);
    }

    /** waits until no tile request is in flight anymore */
    async function settle() {
        for (let i = 0; i < 100; i++) {
            await setTimeout(10);
            if (!Object.keys(maprizon.cache().requests.inflight).length) return;
        }
        throw new Error('tile requests did not settle');
    }

    function requestedUrls() {
        return fetchMock.calls().map(call => call[0]);
    }

    async function loadZ15() {
        fetchMock.mock(z15Url, mvtResponse(z15Bytes));
        fetchMock.mock(/maprizon-id\.sfo3\.cdn\.digitaloceanspaces\.com/, 404);
        centerOn(center, 16);
        maprizon.loadImages(context.projection);
        await settle();
    }

    beforeEach(function() {
        iD.services.maprizon = iD.serviceMaprizon;
        fetchMock.reset();

        context = iD.coreContext().assetPath('../dist/').init();
        centerOn(center, 16);

        maprizon = iD.services.maprizon;
        maprizon.reset();
        consoleError = vi.spyOn(console, 'error');
    });

    afterEach(function() {
        fetchMock.reset();
        consoleError.mockRestore();
        delete iD.services.maprizon;
    });


    describe('#init', function() {
        it('initializes the cache one time', function() {
            const cache = maprizon.cache();
            expect(cache).toHaveProperty('images');
            expect(cache).toHaveProperty('sequences');

            maprizon.init();
            expect(maprizon.cache()).toBe(cache);
        });
    });

    describe('#reset', function() {
        it('resets the cache', function() {
            maprizon.cache().foo = 'bar';
            maprizon.reset();
            expect(maprizon.cache()).not.toHaveProperty('foo');
        });
    });

    describe('#loadLines', function() {
        it('loads the sequence overview from the z10 tiles only', async function() {
            const spy = vi.fn();
            fetchMock.mock(z10Url, mvtResponse(z10Bytes));
            fetchMock.mock(/maprizon-id\.sfo3\.cdn\.digitaloceanspaces\.com/, 404);

            centerOn(center, 12);
            maprizon.on('loadedLines', spy);
            maprizon.loadLines(context.projection);
            await settle();

            expect(spy).toHaveBeenCalledTimes(1);
            const urls = requestedUrls();
            expect(urls).toContain(z10Url);
            expect(urls.every(url => /\/10\/\d+\/\d+\.mvt$/.test(url))).toBe(true);

            const lines = maprizon.sequences(context.projection, 12);
            expect(lines.map(d => d.properties.id).sort()).toEqual(['seq-a', 'seq-b']);
            const seqB = lines.find(d => d.properties.id === 'seq-b');
            expect(seqB.geometry.type).toBe('LineString');
            expect(seqB.properties).toEqual({ id: 'seq-b', type: 'equirectangular', date: '2022-03-03' });
            expect(seqB.geometry.coordinates[0][0]).toBeCloseTo(7.40, 3);
            expect(seqB.geometry.coordinates[0][1]).toBeCloseTo(46.95, 3);

            // the overview lines are not images
            expect(maprizon.images(context.projection)).toEqual([]);
            expect(consoleError).not.toHaveBeenCalled();
        });

        it('does not load tiles around null island', async function() {
            fetchMock.mock(/maprizon-id\.sfo3\.cdn\.digitaloceanspaces\.com/, 404);
            centerOn([0, 0], 12);
            maprizon.loadLines(context.projection);
            await setTimeout(20);
            expect(fetchMock.calls().length).toBe(0);
        });
    });

    describe('#loadImages', function() {
        it('loads pictures and sequences from the z15 tiles only', async function() {
            const spy = vi.fn();
            maprizon.on('loadedImages', spy);
            await loadZ15();

            expect(spy).toHaveBeenCalledTimes(1);
            const urls = requestedUrls();
            expect(urls).toContain(z15Url);
            expect(urls.every(url => /\/15\/\d+\/\d+\.mvt$/.test(url))).toBe(true);

            const ids = maprizon.images(context.projection).map(d => d.id).sort();
            expect(ids).toEqual(['pic-0', 'pic-1', 'pic-2', 'pic-4', 'still-1']);

            // only the sequences of the visible pictures are returned at z>=15
            const lines = maprizon.sequences(context.projection, 16);
            expect(lines.map(d => d.properties.id)).toEqual(['seq-a']);
            expect(consoleError).not.toHaveBeenCalled();
        });

        it('treats a missing tile (404) as empty, without an error', async function() {
            const spy = vi.fn();
            fetchMock.mock(/maprizon-id\.sfo3\.cdn\.digitaloceanspaces\.com/, 404);
            maprizon.on('loadedImages', spy);
            maprizon.loadImages(context.projection);
            await settle();

            expect(fetchMock.calls().length).toBeGreaterThan(0);
            expect(spy).not.toHaveBeenCalled();
            expect(maprizon.images(context.projection)).toEqual([]);
            expect(consoleError).not.toHaveBeenCalled();

            // and the empty tile is not requested again
            const count = fetchMock.calls().length;
            maprizon.loadImages(context.projection);
            await settle();
            expect(fetchMock.calls().length).toBe(count);
        });

        it('treats a forbidden tile (403, missing object on Spaces) as empty, without an error', async function() {
            fetchMock.mock(/maprizon-id\.sfo3\.cdn\.digitaloceanspaces\.com/, 403);
            maprizon.loadImages(context.projection);
            await settle();

            expect(fetchMock.calls().length).toBeGreaterThan(0);
            expect(maprizon.images(context.projection)).toEqual([]);
            expect(consoleError).not.toHaveBeenCalled();
        });

        it('maps the tile properties onto the image data', async function() {
            await loadZ15();

            const flat = maprizon.cachedImage('pic-1');
            expect(flat.isPano).toBe(false);
            expect(flat.heading).toBe(87.5);
            expect(flat.capture_time).toBe('2024-05-01T08:00:01Z');
            expect(flat.capture_time_parsed.getTime()).toBe(Date.parse('2024-05-01T08:00:01Z'));
            expect(flat.sequence_id).toBe('seq-a');
            expect(flat.sequence_index).toBe(1);
            expect(flat.image_path).toBe('https://images.example.com/seq-a/1.jpg');
            expect(flat.loc[0]).toBeCloseTo(7.4945, 4);
            expect(flat.loc[1]).toBeCloseTo(46.9, 4);

            const pano = maprizon.cachedImage('still-1');
            expect(pano.isPano).toBe(true);
            expect(pano.heading).toBe(270);
            expect(pano.sequence_id).toBeUndefined();
            expect(pano.image_path).toBe('https://images.example.com/still-1.jpg');
        });
    });

    describe('#images', function() {
        it('returns only the images in the visible map area', async function() {
            await loadZ15();
            centerOn([7.4935, 46.9], 19);
            const ids = maprizon.images(context.projection).map(d => d.id);
            expect(ids).toEqual(['pic-0']);
        });

        it('returns an empty array when nothing is loaded', function() {
            expect(maprizon.images(context.projection)).toEqual([]);
        });
    });

    describe('#neighborImage', function() {
        it('finds the next and previous picture by sequence_index', async function() {
            await loadZ15();
            expect(maprizon.neighborImage('pic-1', 1).id).toBe('pic-2');
            expect(maprizon.neighborImage('pic-1', -1).id).toBe('pic-0');
        });

        it('returns nothing when the neighbor is not in the cache', async function() {
            await loadZ15();
            expect(maprizon.neighborImage('pic-0', -1)).toBeUndefined();
            expect(maprizon.neighborImage('pic-2', 1)).toBeUndefined();   // picture 3 is missing
            expect(maprizon.neighborImage('pic-4', -1)).toBeUndefined();
            expect(maprizon.neighborImage('still-1', 1)).toBeUndefined();
            expect(maprizon.neighborImage('still-1', -1)).toBeUndefined();
        });
    });

    describe('#selectImage', function() {
        let container;

        beforeEach(function() {
            // the markup created by `ensureViewerLoaded` (without the photo frames)
            container = d3_select(document.createElement('div'));
            const wrap = container.append('div').attr('class', 'photoviewer')
                .append('div').attr('class', 'photo-wrapper maprizon-wrapper');
            wrap.append('div').attr('class', 'photo-attribution');
            const controls = wrap.append('div').attr('class', 'photo-controls-maprizon');
            controls.append('button').attr('class', 'back');
            controls.append('button').attr('class', 'forward');
            context.container(container);
        });

        it('sets the active image, attribution and stepping buttons without any request', async function() {
            await loadZ15();
            const requestCount = fetchMock.calls().length;

            maprizon.selectImage(context, 'pic-1');
            expect(maprizon.getActiveImage().id).toBe('pic-1');
            expect(container.select('button.back').classed('hide')).toBe(false);
            expect(container.select('button.forward').classed('hide')).toBe(false);

            maprizon.selectImage(context, 'pic-2');
            expect(container.select('button.back').classed('hide')).toBe(false);
            expect(container.select('button.forward').classed('hide')).toBe(true);

            maprizon.selectImage(context, 'still-1');
            expect(container.select('button.back').classed('hide')).toBe(true);
            expect(container.select('button.forward').classed('hide')).toBe(true);

            const attribution = container.select('.photo-attribution');
            expect(attribution.select('.captured_at').empty()).toBe(false);
            const image = maprizon.cachedImage('still-1');
            expect(attribution.select('a.report-photo').attr('href'))
                .toBe('https://app.maprizon.com/removal-request?image=' + encodeURIComponent(image.image_path));
            expect(attribution.select('a.image-link').attr('href')).toBe('https://maprizon.com');
            expect(attribution.select('a.image-link').text()).toBe('Maprizon');
            expect(attribution.select('a.license').attr('href')).toBe('https://app.maprizon.com/terms');
            expect(attribution.select('a.license').text()).toBe('CC BY-SA 4.0');

            // the image itself is the only other resource: no API call is made
            expect(fetchMock.calls().length).toBe(requestCount);
            expect(requestedUrls().every(url => url.startsWith(tileHost))).toBe(true);
        });

        it('clears the active image for an unknown id', function() {
            maprizon.selectImage(context, 'nope');
            expect(maprizon.getActiveImage()).toBeNull();
        });
    });

    describe('svgMaprizonImages', function() {
        let surface, dispatch, layer, dates;

        beforeEach(async function() {
            await loadZ15();
            dates = undefined;
            dispatch = d3_dispatch('change', 'photoDatesChanged');
            dispatch.on('photoDatesChanged', (service, d) => {
                if (service === 'maprizon') dates = d;
            });
            surface = d3_select(document.createElement('div')).append('svg');
            layer = iD.svgMaprizonImages(context.projection, context, dispatch);
            layer.enabled(true);
        });

        afterEach(function() {
            layer.enabled(false);
        });

        function drawnImageIds() {
            surface.call(layer);
            return surface.selectAll('.layer-maprizon .viewfield-group').data().map(d => d.id).sort();
        }

        function drawnSequenceIds() {
            return surface.selectAll('.layer-maprizon .sequence').data().map(d => d.properties.id);
        }

        it('draws the pictures and sequences and reports their dates to the date slider', function() {
            expect(drawnImageIds()).toEqual(['pic-0', 'pic-1', 'pic-2', 'pic-4', 'still-1']);
            expect(drawnSequenceIds()).toEqual(['seq-a']);
            expect(dates).toContain('2023-01-15T12:00:00Z');
            expect(dates).toContain('2024-05-01');
        });

        it('filters by date, inclusive of both ends', function() {
            context.photos().setDateFilter('fromDate', '2024-05-01');
            expect(drawnImageIds()).toEqual(['pic-0', 'pic-1', 'pic-2', 'pic-4']);
            expect(drawnSequenceIds()).toEqual(['seq-a']);

            context.photos().setDateFilter('fromDate', null);
            context.photos().setDateFilter('toDate', '2023-01-15');
            expect(drawnImageIds()).toEqual(['still-1']);
            expect(drawnSequenceIds()).toEqual([]);

            context.photos().setDateFilter('toDate', null);
        });

        it('filters by photo type', function() {
            expect(context.photos().shouldFilterByPhotoType()).toBe(true);

            context.photos().togglePhotoType('panoramic');
            expect(drawnImageIds()).toEqual(['pic-0', 'pic-1', 'pic-2', 'pic-4']);
            expect(drawnSequenceIds()).toEqual(['seq-a']);
            context.photos().togglePhotoType('panoramic');

            context.photos().togglePhotoType('flat');
            expect(drawnImageIds()).toEqual(['still-1']);
            expect(drawnSequenceIds()).toEqual([]);
            context.photos().togglePhotoType('flat');
        });

        it('enables the date and photo type filters, but not the username filter', function() {
            expect(context.photos().shouldFilterDateBySlider()).toBe(true);
            expect(context.photos().shouldFilterByPhotoType()).toBe(true);
            expect(context.photos().shouldFilterByUsername()).toBe(false);
        });
    });
});
