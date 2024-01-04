import {CaretPosition, AllFrameTypesIdentifier, FrameObject, LabelSlotsContent, getFrameDefType, SlotsStructure} from "@/types/types";
import {useStore} from "@/store/store";
import {operators, trimmedKeywordOperators} from "@/helpers/editor";

export interface ParsedConcreteTree {
    type: number;
    value: null | string;
    lineno? : number;
    col_offset?: number;
    children: null | ParsedConcreteTree[];
}

interface CopyState {
    nextId: number;
    addTo: number[];
    parent: FrameObject | null;
    
}

declare const Sk: any;

// Simplifies a tree (by collapsing all single-child nodes into the child) in order to make
// it easier to read while debugging
function debugToString(p : ParsedConcreteTree, curIndent: string) : string {
    let s = curIndent + (Sk.ParseTables.number2symbol[p.type] || ("#" + p.type));
    if (p.value) {
        s += " {{" + p.value + "}}";
    }
    if (p.children != null && p.children.length > 0) {
        s += ":\n";
        for (const child of p.children) {
            s += debugToString(child, curIndent + "  ");
        }
        return s;
    }
    else {
        return s + "\n";
    }
}

function addFrame(frame: FrameObject, s: CopyState) : CopyState {
    const id = s.nextId;
    frame.id = id;
    useStore().copiedFrames[id] = frame;
    s.addTo.push(id);
    if (s.parent != null) {
        frame.parentId = s.parent.id;
        // Don't need to add to children because that will already be the addTo array
    }
    return {...s, nextId: s.nextId + 1};
}

function makeFrame(type: string, slots: { [index: number]: LabelSlotsContent}) : FrameObject {
    return {
        frameType : getFrameDefType(type),
        caretVisibility: CaretPosition.none,
        childrenIds: [],
        id: -100, // Will be set during addFrame
        isCollapsed: false,
        isDisabled: false,
        isSelected: false,
        isVisible: true,
        jointFrameIds: [],
        jointParentId: 0,
        labelSlotsDict: slots,
        multiDragPosition: "",
        parentId: -100,
        runTimeError: "",
    };
}

export function copyFramesFromParsedPython(parsedBySkulpt: ParsedConcreteTree) : boolean {
    //console.log("Handling:\n" + debugToString(parsedBySkulpt, "  "));
    useStore().copiedFrames = {};
    useStore().copiedSelectionFrameIds = [];
    try {
        // To avoid problems, choose an ID way outside the existing frames:
        copyFramesFromPython(parsedBySkulpt, {nextId: 1000000, addTo: useStore().copiedSelectionFrameIds, parent: null});
        return true;
    }
    catch (e) {
        console.error(e, "On:\n" + debugToString(parsedBySkulpt, "  "));
        // Don't leave partial content:
        useStore().copiedFrames = {};
        useStore().copiedSelectionFrameIds = [];
        return false;
    }
}

function concatSlots(lhs: SlotsStructure, operator: string, rhs: SlotsStructure) : SlotsStructure {
    return {fields: [...lhs.fields, ...rhs.fields], operators: [...lhs.operators, {code: operator}, ...rhs.operators]};
}

function digValue(p : ParsedConcreteTree) : string {
    if (p.value) {
        return p.value;
    }
    else if (p.children == null) {
        throw new Error("Node with no value and no children");
    }
    else if (p.children.length == 1) {
        return digValue(p.children[0]);
    }
    else if (p.type == Sk.ParseTables.sym.comp_op && p.children.length == 2) {
        // "is not" and "not in" show up as this type, with two children:
        return digValue(p.children[0]) + " " + digValue(p.children[1]);
    }
    else {
        throw new Error("Can't find single value in:\n" + debugToString(p, "  "));
    }
}

function toSlots(p: ParsedConcreteTree) : SlotsStructure {
    // Handle terminal nodes by just plonking them into a single-field slot:
    if (p.children == null || p.children.length == 0) {
        return {fields: [{code: p.value ?? ""}], operators: []};
    }
    
    // Skulpt's parser seems to output a huge amount of dummy nodes with one child,
    // e.g. an OR inside an AND.  We have a catch-all that just descends if there's only one child:
    if (p.children.length == 1) {
        return toSlots(p.children[0]);
    }
    
    // Watch out for unary expressions:
    if (p.children[0].value === "-" || p.children[0].value === "not") {
        return concatSlots({fields: [{code: ""}], operators: []}, p.children[0].value, toSlots(p.children[1]));
    }
    
    // Check for brackets:
    if (p.children[0].value === "(" || p.children[0].value === "[" || p.children[0].value === "{") {
        const bracketed =  toSlots({...p, children: p.children.slice(1, p.children.length - 1)});
        // For parameters, we drop the brackets and keep the content:
        if (p.type == Sk.ParseTables.sym.parameters) {
            return bracketed;
        }
        // Bracketed items must be surrounded by empty slot and empty operator each side:
        return {fields: [{code: ""},{...bracketed, openingBracketValue: p.children[0].value}, {code: ""}], operators: [{code: ""}, {code: ""}]};
    }
    
    let cur = toSlots(p.children[0]);
    for (let i = 1; i < p.children.length; i += 2) {
        if (p.children[i].type === Sk.ParseTables.sym.trailer) {
            // A suffix, like an array index lookup.  Join it and move forward only by one:
            const grandchildren = p.children[i].children;
            if (grandchildren != null && grandchildren[0].value === ".") {
                cur = concatSlots(cur, ".", toSlots(grandchildren[1]));
            }
            else {
                // Something bracketed:
                cur = concatSlots(cur, "", toSlots(p.children[i]));
            }
            i -= 1;
            continue;
        }
        let op;
        try {
            op = digValue(p.children[i]);
        }
        catch (err) {
            throw new Error("Cannot find operator " + i + " in:\n" + debugToString(p, ""), {cause: err});
        }
        if (op != null && (operators.includes(op) || trimmedKeywordOperators.includes(op))) {
            cur = concatSlots(cur, op, toSlots(p.children[i + 1]));
        }
        else {
            throw new Error("Unknown operator: " + p.children[i].type + " \"" + op + "\"");
        }
    }
    return cur;
    
    //throw new Error("Unknown expression type: " + p.type);
}

function children(p : ParsedConcreteTree) : ParsedConcreteTree[] {
    if (p.children == null) {
        throw new Error("Null children on node " + JSON.stringify(p));
    }
    return p.children;
}

function makeFrameWithBody(p: ParsedConcreteTree, frameType: string, childrenIndicesForSlots: number[], childIndexForBody: number, s : CopyState, afterwards? : ((f : FrameObject) => void)) : CopyState {
    const slots : { [index: number]: LabelSlotsContent} = {};
    for (let slotIndex = 0; slotIndex < childrenIndicesForSlots.length; slotIndex++) {
        slots[slotIndex] = {slotStructures : toSlots(children(p)[childrenIndicesForSlots[slotIndex]])};
    }
    const frame = makeFrame(frameType, slots);
    s = addFrame(frame, s);
    const nextId = copyFramesFromPython(children(p)[childIndexForBody], {nextId: s.nextId, addTo: frame.childrenIds, parent: frame}).nextId;
    if (afterwards !== undefined) {
        afterwards(frame);
    }
    return {...s, nextId: nextId};
}

// Returns the frame ID of the next insertion point for any following statements
function copyFramesFromPython(p: ParsedConcreteTree, s : CopyState) : CopyState {
    console.log("Processing type: " + (Sk.ParseTables.number2symbol[p.type] || ("#" + p.type)));
    switch (p.type) {
    case Sk.ParseTables.sym.file_input:
        // The outer wrapper for the whole file, just dig in:
        for (const child of children(p)) {
            s = copyFramesFromPython(child, s);
        }
        break;
    case Sk.ParseTables.sym.stmt:
    case Sk.ParseTables.sym.simple_stmt:
    case Sk.ParseTables.sym.small_stmt:
    case Sk.ParseTables.sym.flow_stmt:
    case Sk.ParseTables.sym.compound_stmt:
        // Wrappers where we just skip to the children:
        for (const child of children(p)) {
            s = copyFramesFromPython(child, s);
        }
        break;
    case Sk.ParseTables.sym.expr_stmt:
        if (p.children) {
            const index = p.children.findIndex((x) => x.value === "=");
            if (index >= 0) {
                // An assignment
                const lhs = toSlots({...p, children: p.children.slice(0, index)});
                const rhs = toSlots({...p, children: p.children.slice(index + 1)});
                s = addFrame(makeFrame(AllFrameTypesIdentifier.varassign, {0: {slotStructures: lhs}, 1: {slotStructures: rhs}}), s);
            }
            else {
                // Everything else goes in method call:
                s = addFrame(makeFrame(AllFrameTypesIdentifier.empty, {0: {slotStructures: toSlots(p)}}), s);
            }
        }
        break;
    case Sk.ParseTables.sym.pass_stmt:
        // We do not insert pass frames
        break;
    case Sk.ParseTables.sym.break_stmt:
        s = addFrame(makeFrame(AllFrameTypesIdentifier.break, {}), s);
        break;
    case Sk.ParseTables.sym.continue_stmt:
        s = addFrame(makeFrame(AllFrameTypesIdentifier.continue, {}), s);
        break;
    case Sk.ParseTables.sym.raise_stmt:
        s = addFrame(makeFrame(AllFrameTypesIdentifier.raise, {0: {slotStructures: toSlots(children(p)[1])}}), s);
        break;
    case Sk.ParseTables.sym.return_stmt:
        s = addFrame(makeFrame(AllFrameTypesIdentifier.return, {0: {slotStructures: toSlots(children(p)[1])}}), s);
        break;
    case Sk.ParseTables.sym.if_stmt: {
        // First child is keyword, second is the condition, third is colon, fourth is body
        const ifFrame: FrameObject[] = [];
        s = makeFrameWithBody(p, AllFrameTypesIdentifier.if, [1], 3, s, (f : FrameObject) => ifFrame.push(f));
        // If can have elif, else, so keep going to check for that:
        for (let i = 4; i < children(p).length; i++) {
            if (children(p)[i].value === "else") {
                // Skip the else and the colon, which are separate tokens:
                i += 2;
                s = makeFrameWithBody(p, AllFrameTypesIdentifier.else, [], i, {...s, addTo: ifFrame[0].jointFrameIds}, (f) => {
                    f.jointParentId = ifFrame[0].id;
                });
            }
            else if (children(p)[i].value === "elif") {
                // Skip the elif:
                i += 1;
                s = makeFrameWithBody(p, AllFrameTypesIdentifier.elif, [i], i + 2, {...s, addTo: ifFrame[0].jointFrameIds}, (f) => {
                    f.jointParentId = ifFrame[0].id;
                });
                // Skip the condition and the colon:
                i += 2;
            }
        }
        break;
    }
    case Sk.ParseTables.sym.while_stmt:
        // First child is keyword, second is the condition, third is colon, fourth is body
        s = makeFrameWithBody(p, AllFrameTypesIdentifier.while, [1], 3, s);
        break;
    case Sk.ParseTables.sym.for_stmt:
        // First child is keyword, second is the loop var, third is keyword, fourth is collection, fifth is colon, sixth is body
        s = makeFrameWithBody(p, AllFrameTypesIdentifier.for, [1, 3], 5, s);
        break;
    case Sk.ParseTables.sym.suite:
        // I don't really understand what this does, but it seems if we ignore the extra children we can proceed:
        for (const child of children(p)) {
            if (child.type > 250) { // Only count the non-expression nodes
                s = copyFramesFromPython(child, s);
            }
        }
        break;
    case Sk.ParseTables.sym.funcdef:
        // First child is keyword, second is the name, third is params, fourth is colon, fifth is body
        s = makeFrameWithBody(p, AllFrameTypesIdentifier.funcdef, [1, 2], 4, s);
        break;
    }
    return s;
}
