import { geoEdgeEqual } from '../geo';
import { utilArrayIntersection } from '../util';


export function actionAddMidpoint(midpoint, node) {
    return function(graph) {
        graph = graph.replace(node.move(midpoint.loc));

        var parents = utilArrayIntersection(
            graph.parentWays(graph.entity(midpoint.edge[0])),
            graph.parentWays(graph.entity(midpoint.edge[1]))
        );

        // inherit prop val from parent(s)
        if (parents.length > 0) {
            node.proprietary = (parents[0] && parents[1]) ? parents[0].proprietary && parents[1].proprietary : parents[0].proprietary;
            console.log(node);
        } 

        parents.forEach(function(way) {
            for (var i = 0; i < way.nodes.length - 1; i++) {
                if (geoEdgeEqual([way.nodes[i], way.nodes[i + 1]], midpoint.edge)) {
                    graph = graph.replace(graph.entity(way.id).addNode(node.id, i + 1));

                    // Add only one midpoint on doubled-back segments,
                    // turning them into self-intersections.
                    return;
                }
            }
        });

        return graph;
    };
}
