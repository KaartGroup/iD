import { actionDiscardTags } from '../actions/discard_tags';

var nonPropUploaded = false;
var context_prop = undefined;

export function setNonPropUploaded(val) {
    nonPropUploaded = val;
}

export function objProprietaryState(_entityIDs, context_as_param) {
    if (!context_prop) context_prop = context_as_param;
    return context_as_param.entity(_entityIDs).proprietary;
}

export function getPropDataExistence(context_as_param) {
    var objs = [];
    condenseChanges(objs, context_as_param);
    return objs.some(function(element) { return element.proprietary === true;});
}

export function fixUiSummary(history, context_as_param) {
    var summary = history.difference().summary();
    var obj;

    if (!getPropDataExistence(context_as_param)) return summary;
    var sumNonProp = [], sumProp = [];

    for (obj in summary) {
        if (summary[obj].entity.proprietary === true) {
            sumProp.push(summary[obj]);
        } else {
            sumNonProp.push(summary[obj]);
        }
    }
    
    return (getNonPropDataExistence(context_as_param) && getPropDataExistence(context_as_param)) ? sumNonProp : sumProp;
}

export function getNonPropDataExistence(context_as_param) {
    var objs = [];
    condenseChanges(objs, context_as_param);
    if (nonPropUploaded) return false;
    return objs.some(function(element) { return element.proprietary === false;});
}

export function separatePropFromNonProp(changes,_pFeat, _npFeat) {
    if (changes.modified.length) {
        for (obj in changes.modified) {
            if (changes.modified[obj].proprietary === true)
                _pFeat.modified.push(changes.modified[obj]);
            else 
                _npFeat.modified.push(changes.modified[obj]);
        }
    } 
    
    if (changes.created.length) {
        for (obj in changes.created) {
            if (changes.created[obj].proprietary === true) 
                _pFeat.created.push(changes.created[obj]);
            else 
                _npFeat.created.push(changes.created[obj]);
        }
    } 
    
    if (changes.deleted.length) {
        for (obj in changes.deleted) {
            if (changes.deleted[obj].proprietary === true) 
                _pFeat.deleted.push(changes.deleted[obj]);
            else 
                _npFeat.deleted.push(changes.deleted[obj]);
        }
    }
}

export function setObjAndChildren(obj, val, context_as_param) {
    obj.proprietary = val;
    if (obj.nodes) {
        for (child in obj.nodes) {
            var childNode = context_as_param.entity(obj.nodes[child]);
            childNode.proprietary = val;
        }
    }
}

export function condenseChanges(objs, context_as_param) {
    let _discardTags;
    var history = context_as_param.history();
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

export function getContext() {
    return context_prop;
}
