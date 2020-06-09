import { dispatch as d3_dispatch } from 'd3-dispatch';

import { t } from '../core/localizer';
import { svgIcon } from '../svg/index';
import { utilRebind } from '../util';
import { setObjAndChildren } from '../services/simple_internal_fcns';


export function uiPropDialogue(context) {
    var dispatch = d3_dispatch('picked_prop_val');
    var _entityIDs;
    var _autofocus = false;
    var _propChosen = false;

    function propDialogue(selection) {
        if (!_entityIDs) return;

        selection.html('');

        var messagewrap = selection
            .append('div')
            .attr('class', 'header fillL');

        var message = messagewrap
            .append('h3')
            .text(t('inspector.choose'));
            
        var bodyEnter = selection
            .append('div')
            .attr('class', 'simple-proprietary-dialogue inspector-body');

        bodyEnter
            .append('h4')
            .text(t('proprietary.title'))
            .style('text-align','center')
            .style('font-weight','normal')
            .style('padding-top', '10px');
        
        presetItem(bodyEnter, {
            iconName: '#iD-icon-apply',
            label: t('proprietary.prop_obj.label'),
            description: t('proprietary.prop_obj.description'),
            onClick: function() { propObj(true); }
        }, 'proprietary-features-accept');

        presetItem(bodyEnter, {
            iconName: '#iD-icon-no',
            label: t('proprietary.osm_obj.label'),
            description: t('proprietary.osm_obj.description'),
            onClick: function() { propObj(false); }
        }, 'proprietary-features-reject');
    }

    function propObj(propVal) {
        var obj = context.entity(_entityIDs);
        setObjAndChildren(obj, propVal, context);
        _propChosen = true;
        dispatch.call('picked_prop_val', this);
    }

    function presetItem(selection, p, presetButtonClasses) {
        var presetItem = selection
            .append('div')
            .attr('class', 'simple-preset-list-item');

        var presetWrap = presetItem
            .append('div')
            .attr('class', 'simple-preset-list-button-wrap');

        var presetReference = presetItem
            .append('div')
            .attr('class', 'simple-tag-reference-body');

        presetReference
            .text(p.description);

        var presetButton = presetWrap
            .append('button')
            .attr('class', 'simple-preset-list-button ' + presetButtonClasses)
            .on('click', p.onClick);

        if (p.disabledFunction) {
            presetButton = presetButton.classed('disabled', p.disabledFunction);
        }

        presetButton
            .append('div')
            .attr('class', 'simple-preset-icon-container medium')
            .append('svg')
            .attr('class', 'icon')
            .style('height','34px')
            .style('width','34px')
            .append('use')
            .style('fill','none')
            .style('color','#4c4c4c')
            .attr('xlink:href', p.iconName);

        presetButton
            .append('div')
            .attr('class', 'simple-label')
            .append('div')
            .attr('class', 'simple-label-inner')
            .append('div')
            .attr('class', 'simple-namepart')
            .text(p.label);

        presetWrap
            .append('button')
            .attr('class', 'simple-tag-reference-button')
            .attr('title', 'info')
            .attr('tabindex', '-1')
            .on('click', function() {
                presetReference
                    .classed('shown', !presetReference.classed('shown'));
            })
            .call(svgIcon('#iD-icon-inspect'));
    }

    propDialogue.autofocus = function(val) {
        if (!arguments.length) return _autofocus;
        _autofocus = val;
        return propDialogue;
    };

    propDialogue.propChosen = function(val) {
        if (!arguments.length) return _propChosen;
        _propChosen = val;
        return propDialogue;
    };

    propDialogue.entityIDs = function(val) {
        if (!arguments.length) return _entityIDs;
        _entityIDs = val;
        return propDialogue;
    };

    return utilRebind(propDialogue, dispatch, 'on');
}
