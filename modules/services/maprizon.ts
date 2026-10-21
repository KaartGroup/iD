/* eslint-disable @typescript-eslint/no-this-alias */
import { dispatch as d3_dispatch } from 'd3-dispatch';

import { PbfReader } from 'pbf';
import RBush from 'rbush';
import { VectorTile } from '@mapbox/vector-tile';
import { utilRebind, utilTiler } from '../util';
import { geoExtent } from '../geo';
import { t } from '../core/localizer';
import { pannellumPhotoFrame, type PhotoFrame } from './pannellum_photo';
import { planePhotoFrame } from './plane_photo';
import { services } from '.';
import { partitionViewport, type WithBbox } from '../util/partition';
import { localeDateString } from '../util/date';
import { patchHash } from '../behavior';
import type { Projection } from '../geo/raw_mercator';
import type { Tile } from '../util/tiler';
import type { Vec2 } from '../geo/vector';
import type { Feature, LineString, Point } from 'geojson';
import type { coreContext } from '../core';


// Maprizon only publishes static vector tiles: there is no API. Each picture
// in the tiles carries the full URL of its image, and next/previous pictures
// are found in the local cache by `first_sequence` and `sequence_index`.
const baseUrl = 'https://maprizon-id.sfo3.cdn.digitaloceanspaces.com';
const tileUrl = baseUrl + '/{z}/{x}/{y}.mvt';

// the public removal form, prefilled with the photo's URL
const REPORT_URL = 'https://app.maprizon.com/removal-request';
const SITE_URL = 'https://maprizon.com';
// published imagery is CC BY-SA 4.0 under section 5 of the terms
const TERMS_URL = 'https://app.maprizon.com/terms';

const pictureLayer = 'pictures';
const sequenceLayer = 'sequences';

// tiles only exist at these two zoom levels:
// z10 has `sequences` only, z15 has `sequences` and `pictures`
const imageMinZoom = 15;
const lineMinZoom = 10;
const dispatch = d3_dispatch<object, {
    loadedImages: [];
    loadedLines: [];
    viewerChanged: [];
}>('loadedImages', 'loadedLines', 'viewerChanged');

export interface MaprizonImage {
    service: 'photo';
    loc: Vec2;
    id: string;
    capture_time: string;
    capture_time_parsed: Date;
    sequence_id?: string;
    sequence_index?: number;
    heading: number;
    image_path: string;
    isPano: boolean;
}

export type MaprizonSequence = Feature<LineString, {
    id: string;
    type: 'equirectangular' | 'flat';
    date: string;
}>;

type RawPicture = Feature<Point, {
    id: string | number;
    ts: string;
    first_sequence?: string | number;
    sequence_index?: string | number;
    heading?: string | number;
    type: 'equirectangular' | 'flat';
    url: string;
}>;

type Which = 'images' | 'lines';

interface ActiveImage {
    id: string;
    sequence_id?: string;
    loc: Vec2;
}

let _cache: {
    images: {
        rtree: RBush<WithBbox<MaprizonImage>>;
        forImageId: { [imageId: string]: MaprizonImage };
        forSequence: { [sequenceId: string]: { [sequenceIndex: number]: MaprizonImage } };
    };
    sequences: { lineString: { [sequenceId: string]: MaprizonSequence[] } };
    mockSequences: { lineString: { [sequenceId: string]: MaprizonSequence[] } };
    requests: {
        loaded: { [tileId: string]: boolean };
        inflight: { [tileId: string]: AbortController };
    };
};
let _loadViewerPromise: Promise<void> | undefined;

let _planeFrame: PhotoFrame;
let _pannellumFrame: PhotoFrame;
let _currentFrame: PhotoFrame | undefined;

let _activeImage: ActiveImage | null;
let _isViewerOpen = false;


/**
 * Return no more than `limit` results per partition, evenly spaced through
 * each partition and always including the active image.
 */
function searchLimited(limit: number | undefined, projection: Projection, rtree: RBush<WithBbox<MaprizonImage>>) {
    limit ||= 5;

    return partitionViewport(projection)
        .reduce<MaprizonImage[]>(function(result, extent) {
            const found = rtree.search(extent.bbox());
            const spacing = Math.max(1, Math.floor(found.length / limit));
            const picked = found
                .filter((d, idx) => idx % spacing === 0 ||
                                    d.data.id === _activeImage?.id)
                .sort((a, b) => {
                    if (a.data.id === _activeImage?.id) return -1;
                    if (b.data.id === _activeImage?.id) return  1;
                    return 0;
                })
                .slice(0, limit)
                .map(d => d.data);

            return (picked.length ? result.concat(picked) : result);
        }, []);
}

/** Load all data for the specified type from the Maprizon tiles of one zoom level */
function loadTiles(which: Which, tileZoom: number, projection: Projection) {
    const tiler = utilTiler().zoomExtent([tileZoom, tileZoom]).skipNullIsland(true);
    const tiles = tiler.getTiles(projection);

    tiles.forEach(function(tile) {
        loadTile(which, tile);
    });
}

/**
 * Load all data for the specified type from one vector tile.
 * A missing tile (Spaces answers 403 or 404) means there is no data there.
 */
function loadTile(which: Which, tile: Tile) {
    const cache = _cache.requests;
    const tileId = `${tile.id}-${which}`;
    if (cache.loaded[tileId] || cache.inflight[tileId]) return;
    const controller = new AbortController();
    cache.inflight[tileId] = controller;
    const requestUrl = tileUrl
        .replace('{x}', String(tile.xyz[0]))
        .replace('{y}', String(tile.xyz[1]))
        .replace('{z}', String(tile.xyz[2]));

    fetch(requestUrl, { signal: controller.signal })
        .then(function(response) {
            if (response.status === 403 || response.status === 404) {
                return null;   // no tile = no data here
            }
            if (!response.ok) {
                throw new Error(response.status + ' ' + response.statusText);
            }
            return response.arrayBuffer();
        })
        .then(function(data) {
            delete cache.inflight[tileId];
            cache.loaded[tileId] = true;
            if (!data || data.byteLength === 0) return;

            loadTileDataToCache(data, tile);

            if (which === 'images') {
                dispatch.call('loadedImages');
            } else {
                dispatch.call('loadedLines');
            }
        })
        .catch(function(e) {
            delete cache.inflight[tileId];
            if (e.name === 'AbortError') return;
            // don't retry a failing tile on every redraw
            cache.loaded[tileId] = true;
            console.error(e); // eslint-disable-line no-console
        });
}

/** Parses one vector tile and adds its pictures and sequences to the cache */
function loadTileDataToCache(data: ArrayBuffer, tile: Tile) {
    const vectorTile = new VectorTile(new PbfReader(data));
    const [x, y, z] = tile.xyz;

    if (Object.hasOwnProperty.call(vectorTile.layers, pictureLayer)) {
        const features: WithBbox<MaprizonImage>[] = [];
        const cache = _cache.images;
        const layer = vectorTile.layers[pictureLayer];

        for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i).toGeoJSON(x, y, z) as RawPicture;
            const props = feature.properties;
            const loc = feature.geometry.coordinates as Vec2;
            const id = String(props.id);

            // a picture can be repeated in the buffer of a neighboring tile
            if (cache.forImageId[id]) continue;

            const heading = Number(props.heading);
            const sequenceIndex = parseInt(String(props.sequence_index), 10);
            const d: MaprizonImage = {
                service: 'photo',
                loc: loc,
                capture_time: props.ts,
                capture_time_parsed: new Date(props.ts),
                id: id,
                sequence_id: props.first_sequence ? String(props.first_sequence) : undefined,
                sequence_index: Number.isFinite(sequenceIndex) ? sequenceIndex : undefined,
                heading: Number.isFinite(heading) ? heading : 0,
                image_path: props.url,
                isPano: props.type === 'equirectangular'
            };
            cache.forImageId[d.id] = d;
            if (d.sequence_id !== undefined && d.sequence_index !== undefined) {
                cache.forSequence[d.sequence_id] ??= {};
                cache.forSequence[d.sequence_id][d.sequence_index] = d;
            }
            features.push({
                minX: loc[0], minY: loc[1], maxX: loc[0], maxY: loc[1], data: d
            });
        }
        cache.rtree.load(features);
    }

    if (Object.hasOwnProperty.call(vectorTile.layers, sequenceLayer)) {
        // the low zoom tiles only provide an overview of the sequences
        const cache = z < imageMinZoom ? _cache.mockSequences : _cache.sequences;
        const layer = vectorTile.layers[sequenceLayer];

        for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i).toGeoJSON(x, y, z) as MaprizonSequence;
            const id = feature.properties.id;
            if (cache.lineString[id]) {
                cache.lineString[id].push(feature);
            } else {
                cache.lineString[id] = [feature];
            }
        }
    }
}

/**
 * Returns the cached picture next to `image` in its sequence
 * @param image The picture to step from
 * @param stepBy `-1` for the previous picture or `1` for the next one
 * @returns the neighboring picture, or `undefined` if it is not loaded
 */
function neighbor(image: MaprizonImage | undefined, stepBy: number): MaprizonImage | undefined {
    if (!image || image.sequence_id === undefined || image.sequence_index === undefined) return undefined;
    const sequence = _cache.images.forSequence[image.sequence_id];
    return sequence && sequence[image.sequence_index + stepBy];
}

export default new class {
    event!: Pick<typeof dispatch, 'on'>;

    init() {
        if (!_cache) {
            this.reset();
        }

        this.event = utilRebind(this, dispatch, 'on');
    }

    reset() {
        if (_cache) {
            Object.values(_cache.requests.inflight).forEach(function(request) { request.abort(); });
        }

        _cache = {
            images: { rtree: new RBush(), forImageId: {}, forSequence: {} },
            sequences: { lineString: {} },
            mockSequences: { lineString: {} },
            requests: { loaded: {}, inflight: {} }
        };
        _activeImage = null;
    }

    /** Get visible images from cache */
    images(projection: Projection) {
        const limit = 5;
        return searchLimited(limit, projection, _cache.images.rtree);
    }

    /** Get a specific image from cache */
    cachedImage(imageKey: string): MaprizonImage | undefined {
        return _cache.images.forImageId[imageKey];
    }

    /** Fetches images (and sequences) for the visible area from the z15 tiles */
    loadImages(projection: Projection) {
        loadTiles('images', imageMinZoom, projection);
    }

    /** Fetches the sequence overview for the visible area from the z10 tiles */
    loadLines(projection: Projection) {
        loadTiles('lines', lineMinZoom, projection);
    }

    /**
     * Get visible sequences from cache
     * @param zoom Current zoom (if zoom < `imageMinZoom` the overview lines from the z10 tiles are drawn)
     */
    sequences(projection: Projection, zoom: number) {
        const viewport = projection.clipExtent();
        const min: Vec2 = [viewport[0][0], viewport[1][1]];
        const max: Vec2 = [viewport[1][0], viewport[0][1]];
        const bbox = geoExtent(projection.invert(min), projection.invert(max)).bbox();
        const sequenceIds: Record<string, true> = {};
        let lineStrings: MaprizonSequence[] = [];

        if (zoom >= imageMinZoom) {
            _cache.images.rtree.search(bbox).forEach(function(d) {
                if (d.data.sequence_id) {
                    sequenceIds[d.data.sequence_id] = true;
                }
            });
            Object.keys(sequenceIds).forEach(function(sequenceId) {
                if (_cache.sequences.lineString[sequenceId]) {
                    lineStrings = lineStrings.concat(_cache.sequences.lineString[sequenceId]);
                }
            });
            return lineStrings;
        }
        if (zoom >= lineMinZoom) {
            Object.keys(_cache.mockSequences.lineString).forEach(function(sequenceId) {
                lineStrings = lineStrings.concat(_cache.mockSequences.lineString[sequenceId]);
            });
        }
        return lineStrings;
    }

    /** Updates the data for the currently visible image */
    setActiveImage(image: MaprizonImage | null | undefined) {
        if (image && image.id) {
            _activeImage = {
                id: image.id,
                sequence_id: image.sequence_id,
                loc: image.loc
            };
        } else {
            _activeImage = null;
        }
    }

    getActiveImage() {
        return _activeImage;
    }

    /**
     * Returns the cached picture before or after `imageKey` in its sequence
     * @param stepBy `-1` for the previous picture or `1` for the next one
     * @returns the picture, or `undefined` if it is not in the cache
     */
    neighborImage(imageKey: string, stepBy: number) {
        return neighbor(this.cachedImage(imageKey), stepBy);
    }

    /** Update the currently highlighted sequence and selected bubble */
    setStyles(context: coreContext, hovered?: MaprizonImage | null) {
        const hoveredImageId = hovered && hovered.id;
        const hoveredSequenceId = hovered && hovered.sequence_id;
        const selectedSequenceId = _activeImage && _activeImage.sequence_id;
        const selectedImageId = _activeImage && _activeImage.id;

        const markers = context.container().selectAll<SVGGElement, MaprizonImage>('.layer-maprizon .viewfield-group');
        const sequences = context.container().selectAll<SVGPathElement, MaprizonSequence>('.layer-maprizon .sequence');

        markers
            .classed('highlighted', function(d) {
                return (!!selectedSequenceId && d.sequence_id === selectedSequenceId) || d.id === hoveredImageId;
            })
            .classed('hovered', function(d) { return d.id === hoveredImageId; })
            .classed('currentView', function(d) { return d.id === selectedImageId; });

        sequences
            .classed('highlighted', function(d) { return !!hoveredSequenceId && d.properties.id === hoveredSequenceId; })
            .classed('currentView', function(d) { return !!selectedSequenceId && d.properties.id === selectedSequenceId; });

        // update viewfields if needed
        context.container().selectAll<SVGPathElement, unknown>('.layer-maprizon .viewfield-group .viewfield')
            .attr('d', viewfieldPath);

        function viewfieldPath(this: SVGPathElement) {
            const d = (this.parentNode as Element & { __data__: MaprizonImage }).__data__;
            if (d.isPano && d.id !== selectedImageId) {
                return 'M 8,13 m -10,0 a 10,10 0 1,0 20,0 a 10,10 0 1,0 -20,0';
            } else {
                return 'M 6,9 C 8,8.4 8,8.4 10,9 L 16,-2 C 12,-5 4,-5 0,-2 z';
            }
        }
        return this;
    }

    // Get viewer status
    isViewerOpen() {
        return _isViewerOpen;
    }

    /** Loads the selected image in the frame */
    selectImage(context: coreContext, id: string) {
        const d = this.cachedImage(id);
        this.setActiveImage(d);

        const viewer = context.container()
            .select('.photoviewer');

        if (!viewer.empty()) viewer.datum(d);

        this.setStyles(context, null);

        if (!d) return this;

        patchHash({ photo: 'maprizon/' + d.id });

        const wrap = context.container()
            .select<HTMLElement>('.photoviewer .maprizon-wrapper');

        const attribution = wrap.selectAll('.photo-attribution').text('');

        if (d.capture_time) {
            attribution
                .append('span')
                .attr('class', 'captured_at')
                .text(localeDateString(d.capture_time));

            attribution
                .append('span')
                .text('|');
        }

        attribution
            .append('a')
            .attr('class', 'report-photo')
            .attr('target', '_blank')
            .attr('href', d.image_path
                ? REPORT_URL + '?image=' + encodeURIComponent(d.image_path)
                : REPORT_URL)
            .call(t.append('maprizon.report'));

        attribution
            .append('span')
            .text('|');

        attribution
            .append('a')
            .attr('class', 'image-link')
            .attr('target', '_blank')
            .attr('href', SITE_URL)
            .text('Maprizon');

        attribution
            .append('span')
            .text('|');

        attribution
            .append('a')
            .attr('class', 'license')
            .attr('target', '_blank')
            .attr('href', TERMS_URL)
            .call(t.append('maprizon.license'));

        wrap
            .selectAll('button.back')
            .classed('hide', !neighbor(d, -1));
        wrap
            .selectAll('button.forward')
            .classed('hide', !neighbor(d, 1));

        _currentFrame = d.isPano ? _pannellumFrame : _planeFrame;

        if (_currentFrame) {
            _currentFrame
                .showPhotoFrame(wrap)
                .selectPhoto(d, true);
        }

        return this;
    }

    photoFrame() {
        return _currentFrame;
    }

    ensureViewerLoaded(context: coreContext) {
        const that = this;

        if (_loadViewerPromise) return _loadViewerPromise;

        const wrap = context.container()
            .select('.photoviewer')
            .selectAll('.maprizon-wrapper')
            .data([0]);

        const wrapEnter = wrap.enter()
            .append('div')
            .attr('class', 'photo-wrapper maprizon-wrapper')
            .classed('hide', true)
            .on('dblclick.zoom', null);

        wrapEnter
            .append('div')
            .attr('class', 'photo-attribution fillD');

        const controlsEnter = wrapEnter
            .append('div')
            .attr('class', 'photo-controls-wrap')
            .append('div')
            .attr('class', 'photo-controls-maprizon');

        controlsEnter
            .append('button')
            .classed('back', true)
            .on('click.back', step(-1))
            .text('◄');

        controlsEnter
            .append('button')
            .classed('forward', true)
            .on('click.forward', step(1))
            .text('►');

        _loadViewerPromise = Promise.all([
            pannellumPhotoFrame(context, wrapEnter),
            planePhotoFrame(context, wrapEnter)
        ]).then(([pannellumPhotoFrame, planePhotoFrame]) => {
            _pannellumFrame = pannellumPhotoFrame;
            _pannellumFrame.event.on('viewerChanged', () => dispatch.call('viewerChanged'));
            _planeFrame = planePhotoFrame;
            _planeFrame.event.on('viewerChanged', () => dispatch.call('viewerChanged'));
        });

        /**
         * Loads the next or previous picture of the sequence, if it is in the cache
         * @param stepBy `-1` if backwards or `1` if forward
         */
        function step(stepBy: number) {
            return function() {
                if (!_activeImage) return;

                const nextImage = that.neighborImage(_activeImage.id, stepBy);
                if (!nextImage) return;

                context.map().centerEase(nextImage.loc);
                that.selectImage(context, nextImage.id);
            };
        }

        return _loadViewerPromise;
    }

    /** Shows the current viewer if hidden */
    showViewer(context: coreContext) {
        const wrap = context.container().select('.photoviewer');
        const isHidden = wrap.selectAll('.photo-wrapper.maprizon-wrapper.hide').size();
        if (isHidden) {
            for (const service of Object.values(services)) {
                if (service === this) continue;
                if (service && 'hideViewer' in service && typeof service.hideViewer === 'function') {
                    service.hideViewer(context);
                }
            }
            wrap.classed('hide', false)
                .selectAll('.photo-wrapper.maprizon-wrapper')
                .classed('hide', false);
        }

        _isViewerOpen = true;
        return this;
    }

    /** Hides the current viewer if shown, resets the active image and sequence */
    hideViewer(context: coreContext) {
        const viewer = context.container().select('.photoviewer');
        if (!viewer.empty()) viewer.datum(null);
        patchHash({ photo: null });
        viewer
            .classed('hide', true)
            .selectAll('.photo-wrapper')
            .classed('hide', true);
        context.container().selectAll('.viewfield-group, .sequence, .icon-sign')
            .classed('currentView', false);

        this.setActiveImage(null);
        _isViewerOpen = false;

        return this.setStyles(context, null);
    }

    cache() {
        return _cache;
    }
};
