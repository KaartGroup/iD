export function uiPropSuccess(context) {

    function propSuccess(selection) {
        let header = selection
            .append('div')
            .attr('class', 'header fillL');

        header
            .append('button')
            .attr('class', 'fr')
            .on('click', () => dispatch.call('cancel'))
            .call(svgIcon('#iD-icon-close'));
        
        
        header
            .append('h3')
            .text(t('success.just_edited'));

        let body = selection
            .append('div')
            .attr('class', 'body save-success fillL');

        let summary = body
            .append('div')
            .attr('class', 'save-summary');

        summary
            .append('h3')
            .text(t('success.thank_you' + (_location ? '_location' : ''), { where: _location }));

        summary
            .append('p')
            .text(t('success.help_html'))
            .append('a')
            .attr('class', 'link-out')
            .attr('target', '_blank')
            .attr('tabindex', -1)
            .attr('href', t('success.help_link_url'))
            .call(svgIcon('#iD-icon-out-link', 'inline'))
            .append('span')
            .text(t('success.help_link_text'));

        let changesetURL = osm.changesetURL(_changeset.id);

        let table = summary
            .append('table')
            .attr('class', 'summary-table');

        let row = table
            .append('tr')
            .attr('class', 'summary-row');

        row
            .append('td')
            .attr('class', 'cell-icon summary-icon')
            .append('a')
            .attr('target', '_blank')
            .attr('href', changesetURL)
            .append('svg')
            .attr('class', 'logo-small')
            .append('use')
            .attr('xlink:href', '#iD-logo-osm');

        let summaryDetail = row
            .append('td')
            .attr('class', 'cell-detail summary-detail');

        summaryDetail
            .append('a')
            .attr('class', 'cell-detail summary-view-on-osm')
            .attr('target', '_blank')
            .attr('href', changesetURL)
            .text(t('success.view_on_osm'));

        summaryDetail
            .append('div')
            .html(t('success.changeset_id', {
            changeset_id: `<a href="${changesetURL}" target="_blank">${_changeset.id}</a>`
            }));


        // Get OSM community index features intersecting the map..
        ensureOSMCommunityIndex()
            .then(oci => {
            let communities = [];
            const properties = oci.query(context.map().center(), true) || [];

            // Gather the communities from the result
            properties.forEach(props => {
                const resourceIDs = Array.from(props.resourceIDs);
                resourceIDs.forEach(resourceID => {
                const resource = oci.resources[resourceID];
                communities.push({
                    area: props.area || Infinity,
                    order: resource.order || 0,
                    resource: resource
                });
                });
            });

            // sort communities by feature area ascending, community order descending
            communities.sort((a, b) => a.area - b.area || b.order - a.order);

            body
                .call(showCommunityLinks, communities.map(c => c.resource));
            });
        }
    return utilRebind(propSuccess, dispatch, 'on');
}