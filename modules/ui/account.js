import { event as d3_event } from 'd3-selection';

import { t } from '../core/localizer';
import { svgIcon } from '../svg/icon';


export function uiAccount(context) {
    var osm = context.connection();
    var prop = context.connectionProp();
    var alreadyDrawn = false;

    function update(selection) {
        if (!osm || !prop) return;   

        if (!osm.authenticated() && !prop.authenticated()) {
            selection.selectAll('.userLink, .logoutLink')
                .classed('hide', true);
            return;
        }

        var userLink = selection.select('.userLink'),
            logoutLink = selection.select('.logoutLink');
        userLink.html('');
        logoutLink.html('');

        prop.userDetails(function(err, details) {
            if (err || !details) return;

            if (osm.authenticated()) alreadyDrawn = false;

            if (!alreadyDrawn) {
                selection.selectAll('.userLink, .logoutLink')
                    .classed('hide', false);

                // Link
                userLink.append('a')
                    .attr('href', prop.userURL(details.display_name))
                    .attr('target', '_blank');

                // Add thumbnail or dont
                if (details.image_url) {
                    userLink.append('img')
                        .attr('class', 'icon pre-text user-icon')
                        .attr('src', details.image_url);
                } else {
                    userLink
                        .call(svgIcon('#iD-icon-avatar', 'pre-text light'));
                }

                // Add user name
                userLink.append('span')
                    .attr('class', 'label')
                    .text(details.display_name);               
                alreadyDrawn = true;
            }
        });

        osm.userDetails(function(err, details) {
            if (err || !details) return;

            selection.selectAll('.userLink, .logoutLink')
                .classed('hide', false);

            // Link
            var userLinkA = userLink.append('a')
                .attr('href', osm.userURL(details.display_name))
                .attr('target', '_blank');

            // Add thumbnail or dont
            if (details.image_url) {
                userLinkA.append('img')
                    .attr('class', 'icon pre-text user-icon')
                    .attr('src', details.image_url);
            } else {
                userLinkA
                    .call(svgIcon('#iD-icon-avatar', 'pre-text light'));
            }

            // Add user name
            userLinkA.append('span')
                .attr('class', 'label')
                .html(details.display_name)
        });

        logoutLink.append('a')
                .attr('class', 'logout')
                .attr('href', '#')
                .html(t.html('logout'))
                .on('click.logout', function() {
                    d3_event.preventDefault();
                    osm.logout();
                    prop.logout();
                    location.replace(location.protocol + '//' + location.host + '/logout');
                });
    }


    return function(selection) {

        selection.append('li')
            .attr('class', 'userLink')
            .classed('hide', true);

        selection.append('li')
            .attr('class', 'logoutLink')
            .classed('hide', true);

        if (osm && prop) {
            osm.on('change.account', function() { update(selection); });
            prop.on('change.account', function() { update(selection); });
            update(selection);
        } else if (osm) {
            osm.on('change.account', function() { update(selection); });
            update(selection);
        } else if (prop) {
            prop.on('change.account', function() { update(selection); });
            update(selection);
        }
    };
}
