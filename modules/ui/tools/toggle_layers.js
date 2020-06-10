import _debounce from 'lodash-es/debounce';

import {
    event as d3_event,
    select as d3_select
} from 'd3-selection';

import { t, localizer } from '../../core/localizer';
import { svgIcon } from '../../svg';
import { uiTooltip } from '../tooltip';
import { presetManager } from '../../presets';


export function uiToolToggle(context) {

    var tool = {
        id: 'toggle_layers',
        label: 'Toggle Layers'
    };

    var layers = [
        {
            title: 'OSM Layers',
            id: 'toggle-osm',
            button: 'line',
            description: 'Toggle OSM Features On/Off',
            key: '⌥W'
        },
        {
            title: 'Prop Layers',
            id: 'toggle-prop',
            button: 'line',
            description: 'Toggle Proprietary Features On/Off',
            key: '⌥Q'
        }
    ];

    tool.render = function(selection) {
        var debouncedUpdate = _debounce(update, 100, { leading: true, trailing: true });

        var wrap = selection
            .append('div')
            .attr('class', 'joined')
            .style('display', 'flex');

        context.map()
            .on('move.modes', debouncedUpdate)
            .on('drawn.modes', debouncedUpdate);

        context
            .on('enter.modes', update);
    
        update();

        function update() {
    
            var buttons = wrap.selectAll('button.add-button')
                .data(layers, function(d) { return d.id; });

            buttons.exit()
                .remove();

            // enter
            var buttonsEnter = buttons.enter()
                .append('button')
                .attr('class', function(d) { return d.id + ' add-button bar-button'; })
                .on('click.mode-buttons', function() {
                    console.log('Hello There!');
                })
                .call(uiTooltip()
                    .placement('bottom')
                    .title(function(d) { return d.description; })
                    .keys(function(d) { return d.key; })
                    .scrollContainer(context.container().select('.top-toolbar'))
                );

            buttonsEnter
                .each(function(d) {
                    d3_select(this)
                        .call(svgIcon('#iD-icon-' + d.button));
                });

            buttonsEnter
                .append('span')
                .attr('class', 'label')
                .text(function(d) { return d.title; });
        }
    };
 
    return tool;
}