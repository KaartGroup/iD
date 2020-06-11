import { actionDiscardTags } from '../actions/discard_tags';

var propDbToggle = true;
var nonPropUploaded = false;

export function setNonPropUploaded(val) {
    nonPropUploaded = val;
}

export function objProprietaryState(_entityIDs) {
    return context.entity(_entityIDs).proprietary;
}

export function getPropDataExistence() {
    var objs = [];
    condenseChanges(objs);
    return objs.some(function(element) { return element.proprietary == true;});
}

export function fixUiSummary(history) {
    var summary = history.difference().summary();

    if (!getPropDataExistence()) return summary;
    var sumNonProp = [], sumProp = [];

    for (obj in summary) {
        if (summary[obj].entity.proprietary == true) {
            sumProp.push(summary[obj]);
        } else {
            sumNonProp.push(summary[obj]);
        }
    }
    
    return (getNonPropDataExistence() && getPropDataExistence()) ? sumNonProp : sumProp;
}

export function getNonPropDataExistence() {
    var objs = [];
    condenseChanges(objs);
    if (nonPropUploaded) return false;
    return objs.some(function(element) { return element.proprietary == false;});
}

export function separatePropFromNonProp(changes,_pFeat, _npFeat) {
    if (changes.modified.length) {
        for (obj in changes.modified) {
            if (changes.modified[obj].proprietary == true)
                _pFeat.modified.push(changes.modified[obj]);
            else 
                _npFeat.modified.push(changes.modified[obj]);
        }
    } 
    
    if (changes.created.length) {
        for (obj in changes.created) {
            if (changes.created[obj].proprietary == true) 
                _pFeat.created.push(changes.created[obj]);
            else 
                _npFeat.created.push(changes.created[obj]);
        }
    } 
    
    if (changes.deleted.length) {
        for (obj in changes.deleted) {
            if (changes.deleted[obj].proprietary == true) 
                _pFeat.deleted.push(changes.deleted[obj]);
            else 
                _npFeat.deleted.push(changes.deleted[obj]);
        }
    }
}

export function setObjAndChildren(obj, val) {
    obj.proprietary = val;
    if (obj.nodes) {
        for (child in obj.nodes) {
            var childNode = context.entity(obj.nodes[child]);
            childNode.proprietary = val;
        }
    }
}

export function condenseChanges(objs) {
    let _discardTags;
    var history = context.history();
    var changes = history.changes(actionDiscardTags(history.difference(), _discardTags));
    if (changes.modified.length) {
        for (item in changes.modified)
            objs.push(changes.modified[item]);
    }
    if (changes.created.length) {
        for (item in changes.created)
            objs.push(changes.created[item]);
    }
    if (changes.deleted.length) {
        for (item in changes.deleted)
            objs.push(changes.deleted[item]);
    }
}

// TODO
// may need to send a bool as param to toggle on/off
export function propToggle(val) {
    // code for button toggle should be here...
    // check connection to db...
    // propDbToggle = val; 
}

export function getPropDbStatus() {
    return propDbToggle;
}