export function svgPropFeatures(projection, context, dispatch) {
    var enabled = true;

    function drawPropFeatures(selection) {
        selection.selectAll('.layer-prop')
            .data(['covered', 'areas', 'lines', 'points', 'labels'])
            .enter()
            .append('g')
            .attr('class', function(d) { return 'layer-prop ' + d; });

        selection.selectAll('.layer-prop.points').selectAll('.points-group')
            .data(['points', 'midpoints', 'vertices', 'turns'])
            .enter()
            .append('g')
            .attr('class', function(d) { return 'points-group ' + d; });
    }

    function showLayer() {
        var layer = context.surface().selectAll('.data-layer.prop-features');
        layer.interrupt();

        layer
            .classed('disabled', false)
            .style('opacity', 0)
            .transition()
            .duration(250)
            .style('opacity', 1)
            .on('end interrupt', function () {
                dispatch.call('change');
            });
    }

    function hideLayer() {
        var layer = context.surface().selectAll('.data-layer.prop-features');
        layer.interrupt();

        layer
            .transition()
            .duration(250)
            .style('opacity', 0)
            .on('end interrupt', function () {
                layer.classed('disabled', true);
                dispatch.call('change');
            });
    }

    drawPropFeatures.enabled = function(val) {
        if (!arguments.length) return enabled;
        enabled = val;

        if (enabled) {
            showLayer();
        } else {
            hideLayer();
        }

        dispatch.call('change');
        return this;
    };

    return drawPropFeatures;
}