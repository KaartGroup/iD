import { throttle } from 'es-toolkit';
import type { Dispatch } from 'd3-dispatch';
import { select as d3_select } from 'd3-selection';
import { services } from '../services';
import { svgPath, svgPointTransform } from './helpers';
import type { Projection } from '../geo/raw_mercator';
import type { MaprizonImage, MaprizonSequence } from '../services/maprizon';
import type { coreContext } from '../core';


export function svgMaprizonImages(projection: Projection, context: coreContext, dispatch: Dispatch<object>) {
    const throttledRedraw = throttle(function() { dispatch.call('change'); }, 1000);
    const imageMinZoom = 15;
    const lineMinZoom = 10;
    const viewFieldZoomLevel = 18;
    let layer: d3.Selection<SVGGElement> = d3_select(null!);
    let _maprizon: typeof services.maprizon | null;
    let _viewerYaw = 0;

    function init() {
        if (svgMaprizonImages.initialized) return;
        svgMaprizonImages.enabled = false;
        svgMaprizonImages.initialized = true;
    }

    function getService() {
        if (services.maprizon && !_maprizon) {
            _maprizon = services.maprizon;
            _maprizon.event
                .on('viewerChanged', viewerChanged)
                .on('loadedLines', throttledRedraw)
                .on('loadedImages', throttledRedraw);
        } else if (!services.maprizon && _maprizon) {
            _maprizon = null;
        }

        return _maprizon;
    }

    /**
     * Whether a capture date (`YYYY-MM-DD…`) is inside the date filter of the
     * right panel. The filter values are `YYYY-MM-DD` strings and both ends are
     * inclusive, so comparing the date part of the strings is enough.
     * @param date a date or an ISO timestamp
     */
    function inDateRange(date: string | undefined) {
        const fromDate = context.photos().fromDate();
        const toDate = context.photos().toDate();
        if (!fromDate && !toDate) return true;
        if (!date) return false;
        const day = String(date).slice(0, 10);
        if (fromDate && day < fromDate) return false;
        if (toDate && day > toDate) return false;
        return true;
    }

    /**
     * Filters the images given the filters on the right panel
     * @param skipDateFilter if true, the set date filters will be ignored
     */
    function filterImages(images: MaprizonImage[], skipDateFilter = false) {
        const showsPano = context.photos().showsPanoramic();
        const showsFlat = context.photos().showsFlat();

        if (!showsPano || !showsFlat) {
            images = images.filter(function(image) {
                if (image.isPano) return showsPano;
                return showsFlat;
            });
        }
        if (!skipDateFilter) {
            images = images.filter(image => inDateRange(image.capture_time));
        }

        return images;
    }

    /**
     * Filters the sequences given the filters on the right panel
     * @param skipDateFilter if true, the set date filters will be ignored
     */
    function filterSequences(sequences: MaprizonSequence[], skipDateFilter = false) {
        const showsPano = context.photos().showsPanoramic();
        const showsFlat = context.photos().showsFlat();

        if (!showsPano || !showsFlat) {
            sequences = sequences.filter(function(sequence) {
                if (sequence.properties.type === 'equirectangular') return showsPano;
                return showsFlat;
            });
        }
        if (!skipDateFilter) {
            sequences = sequences.filter(sequence => inDateRange(sequence.properties.date));
        }

        return sequences;
    }

    /**
     * Shows the selected layer
     */
    function showLayer() {
        const service = getService();
        if (!service) return;

        editOn();

        layer
            .style('opacity', 0)
            .transition()
            .duration(250)
            .style('opacity', 1)
            .on('end', function() { dispatch.call('change'); });
    }

    /**
     * Hides the selected layer
     */
    function hideLayer() {
        throttledRedraw.cancel();

        layer
            .transition()
            .duration(250)
            .style('opacity', 0)
            .on('end', editOff);
    }

    /**
     * Updates the viewfinder for the selected image bubble based on the frame's yaw
     * @param d Current Active image Data
     * @param selectedImageId  The selected bubble image ID
     */
    function transform(d: MaprizonImage, selectedImageId: string | undefined) {
        let t = svgPointTransform(projection)(d);
        let rot = d.heading;
        if (d.id === selectedImageId) {
            rot += _viewerYaw;
        }
        if (rot) {
            t += ' rotate(' + Math.floor(rot) + ',0,0)';
        }
        return t;
    }

    function editOn() {
        layer.style('display', 'block');
    }

    function editOff() {
        layer.selectAll('.viewfield-group').remove();
        layer.style('display', 'none');
    }

    /** Updates the current selected image */
    function click(d3_event: MouseEvent, image: MaprizonImage) {
        const service = getService();
        if (!service) return;

        service
            .ensureViewerLoaded(context)
            .then(function() {
                service
                    .selectImage(context, image.id)
                    .showViewer(context);
            });

        context.map().centerEase(image.loc);
    }

    function mouseover(d3_event: MouseEvent, image: MaprizonImage) {
        const service = getService();
        if (service) service.setStyles(context, image);
    }

    function mouseout() {
        const service = getService();
        if (service) service.setStyles(context, null);
    }

    /**
     * Updates the current view, rearranging lines and bubbles.
     */
    function update(this: any) {
        const zoom = ~~context.map().zoom();
        const showViewfields = (zoom >= viewFieldZoomLevel);

        const service = getService();
        let sequences = (service ? service.sequences(projection, zoom) : []);
        let images = (service && zoom >= imageMinZoom ? service.images(projection) : []);
        dispatch.call('photoDatesChanged', this, 'maprizon', [
            ...filterImages(images, true).map(p => p.capture_time),
            ...filterSequences(sequences, true).map(s => s.properties.date)
        ]);

        images = filterImages(images);
        sequences = filterSequences(sequences);

        const traces = layer.selectAll('.sequences').selectAll<SVGPathElement, MaprizonSequence>('.sequence')
            .data(sequences, function(d) { return d.properties.id; });

        // exit
        traces.exit()
            .remove();

        traces.enter()
            .append('path')
            .attr('class', 'sequence')
            .merge(traces)
            .attr('d', svgPath(projection).geojson);


        const groups = layer.selectAll('.markers').selectAll<SVGGElement, MaprizonImage>('.viewfield-group')
            .data(images, function(d) { return d.id; });

        // exit
        groups.exit()
            .remove();

        // enter
        const groupsEnter = groups.enter()
            .append('g')
            .attr('class', 'viewfield-group')
            .on('mouseenter', mouseover)
            .on('mouseleave', mouseout)
            .on('click', click);

        groupsEnter
            .append('g')
            .attr('class', 'viewfield-scale');

        const activeImageId = service?.getActiveImage()?.id;
        // update
        const markers = groups
            .merge(groupsEnter)
            .sort(function(a, b) {
                // active image on top
                if (a.id === activeImageId) return  1;
                if (b.id === activeImageId) return -1;
                // else: sort by capture time (newest on top)
                return a.capture_time_parsed.getTime() - b.capture_time_parsed.getTime();
            })
            .attr('transform', d => transform(d, activeImageId))
            .select('.viewfield-scale');


        markers.selectAll('circle')
            .data([0])
            .enter()
            .append('circle')
            .attr('dx', '0')
            .attr('dy', '0')
            .attr('r', '6');

        const viewfields = markers.selectAll('.viewfield')
            .data(showViewfields ? [0] : []);

        viewfields.exit()
            .remove();

        viewfields.enter()
            .insert('path', 'circle')
            .attr('class', 'viewfield')
            .attr('transform', 'scale(1.5,1.5),translate(-8, -13)')
            .attr('d', viewfieldPath);

        if (service) service.setStyles(context, null);

        function viewfieldPath(this: SVGPathElement) {
            if (this.parentNode!.__data__.isPano) {
                return 'M 8,13 m -10,0 a 10,10 0 1,0 20,0 a 10,10 0 1,0 -20,0';
            } else {
                return 'M 6,9 C 8,8.4 8,8.4 10,9 L 16,-2 C 12,-5 4,-5 0,-2 z';
            }
        }
    }

    function viewerChanged() {
        const service = getService();
        if (!service) return;

        const frame = service.photoFrame();
        if (!frame) return;

        // update viewfield rotation
        _viewerYaw = frame.getYaw();

        // avoid updating if the map is currently transformed
        // e.g. during drags or easing.
        if (context.map().isTransformed()) return;

        layer.selectAll<SVGGElement, MaprizonImage>('.viewfield-group.currentView')
            .attr('transform', d => transform(d, d.id));
    }


    /** Draws bubbles and lines on the current view */
    function drawImages(this: any, selection: d3.Selection<SVGGElement>) {

        const enabled = svgMaprizonImages.enabled;
        const service = getService();

        layer = selection.selectAll<SVGGElement, 0>('.layer-maprizon')
            .data(service ? [0] : []);

        layer.exit()
            .remove();

        const layerEnter = layer.enter()
            .append('g')
            .attr('class', 'layer-maprizon')
            .style('display', enabled ? 'block' : 'none');

        layerEnter
            .append('g')
            .attr('class', 'sequences');

        layerEnter
            .append('g')
            .attr('class', 'markers');

        layer = layerEnter
            .merge(layer);

        if (enabled) {
            const zoom = ~~context.map().zoom();
            if (service) {
                if (zoom >= imageMinZoom) {
                    editOn();
                    update();
                    service.loadImages(projection);
                } else if (zoom >= lineMinZoom) {
                    editOn();
                    update();
                    service.loadLines(projection);
                } else {
                    editOff();
                    dispatch.call('photoDatesChanged', this, 'maprizon', []);
                }
            } else {
                editOff();
            }
        } else {
            dispatch.call('photoDatesChanged', this, 'maprizon', []);
        }
    }

    /** @returns if layer is active */
    drawImages.enabled = function(_: boolean) {
        if (!arguments.length) return svgMaprizonImages.enabled;
        svgMaprizonImages.enabled = _;
        if (svgMaprizonImages.enabled) {
            showLayer();
            context.photos().on('change.maprizon_images', update);
        } else {
            hideLayer();
            context.photos().on('change.maprizon_images', null);
        }
        dispatch.call('change');
        return this;
    };


    drawImages.supported = function() {
        return !!getService();
    };

    /** @returns if layer is drawn */
    drawImages.rendered = function(zoom: number) {
        return zoom >= lineMinZoom;
    };


    init();
    return drawImages;
}
svgMaprizonImages.enabled = false;
svgMaprizonImages.initialized = false;
