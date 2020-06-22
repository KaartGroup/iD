export function svgTouch(_,__,___,isProp=false) {

    function drawTouch(selection) {
        selection.selectAll(isProp ? '.layer-touch-prop' : '.layer-touch')
            .data(['areas', 'lines', 'points', 'turns', 'markers'])
            .enter()
            .append('g')
            .attr('class', function(d) { return (isProp ? 'layer-touch-prop ' : 'layer-touch ') + d; });
    }

    return drawTouch;
}
