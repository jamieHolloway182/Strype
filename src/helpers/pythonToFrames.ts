import {CaretPosition, AllFrameTypesIdentifier, FrameObject, LabelSlotsContent, getFrameDefType, SlotsStructure, StringSlot, BaseSlot, ContainerTypesIdentifiers} from "@/types/types";
import {useStore} from "@/store/store";
import {operators, trimmedKeywordOperators} from "@/helpers/editor";
import i18n from "@/i18n";

const TOP_LEVEL_TEMP_ID = -999;

// Type for the things we get from the Skulpt parser:
export interface ParsedConcreteTree {
    type: number;
    value: null | string;
    lineno? : number;
    col_offset?: number;
    children: null | ParsedConcreteTree[];
}
// A comment or blank line, plus a line number location in the original Python:
interface LocatedCommentOrBlankLine {
    lineNumber: number;
    content: string | null; // If null, it's a blank line (not a blank comment!)
}
// The state passed around while copying from Python code into frames
interface CopyState {
    nextId: number; // The next ID to use for a new frame
    addTo: number[]; // List to add frames to
    parent: FrameObject | null; // The parent, if any, for borrowing the parent ID
    pendingComments: LocatedCommentOrBlankLine[]; // Modified in-place
}

// Declare Skulpt:
declare const Sk: any;

// The different "locations" in Strype 
export enum STRYPE_LOCATION {
    UNKNOWN,
    MAIN_CODE_SECTION,
    IN_FUNCDEF,
    FUNCDEF_SECTION,
    IMPORTS_SECTION,
    TESTDEF_SECTION
}

// Simplifies a tree (by collapsing all single-child nodes into the child) in order to make
// it easier to read while debugging error messages
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

// Given a frame, assigns it a new ID and adds it to the list specified in the CopyState
// If it is not a joint frame, set its parent.
function addFrame(frame: FrameObject, s: CopyState) : CopyState {
    const id = s.nextId;
    frame.id = id;
    useStore().copiedFrames[id] = frame;
    s.addTo.push(id);
    if (!frame.frameType.isJointFrame) {
        if (s.parent != null) {
            frame.parentId = s.parent.id;
            // Don't need to add to children because that will already be the addTo array
        }
        else {
            // The pasting code relies on parent being set to non-zero for non-joint frames,
            // so we just set it to an invalid integer:
            frame.parentId = TOP_LEVEL_TEMP_ID;
        }
    }
    return {...s, nextId: s.nextId + 1};
}

// Makes a basic frame object with the given type and slots, and dummy/default values for all other fields
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
        parentId: 0,
        runTimeError: "",
    };
}

// The main entry point to this module.  Given a string of Python code that the user
// has pasted in, copy it to the store's copiedFrames/copiedSelectionFrameIds fields,
// ready to be pasted immediately afterwards.
// If successful, returns null.  If unsuccessful, returns a string with some info about
// where the Python parse failed.
export function copyFramesFromParsedPython(code: string, currentStrypeLocation: STRYPE_LOCATION, linenoMapping?: Record<number, number>) : string | null {
    const mapLineno = (lineno : number) : number => linenoMapping ? linenoMapping[lineno] : lineno;
    
    // Preprocess; first take off trailing whitespace:
    code = code.trimEnd();

    const codeLines = code.split(/\r?\n/);
    // Then find the common amount of indentation on non-blank lines and remove it:
    // This way if the user parses in something like this from the middle of some Python:
    // "    if x > 8:"
    // "      x = 10"
    // "    else:"
    // "      x = 12"
    // (which is invalid in Python because you can't have a leading indent on the first line),
    // we interpret it as :
    // "if x > 8:"
    // "  x = 10"
    // "else:"
    // "  x = 12"
    // (note that just removing indent on first line wouldn't make the else line up correctly)
    let lowestIndent = 999999;
    for (const codeLine of codeLines) {
        if (codeLine.trim() != "") {
            // Is bound to match because even the empty line matches:
            const indent = (codeLine.match(/^\s*/) as RegExpMatchArray)[0].length;
            if (indent < lowestIndent) {
                lowestIndent = indent;
            }
        }
    }
    // Now remove that indent if it exists:
    if (lowestIndent > 0) {
        for (let i = 0; i < codeLines.length; i++) {
            codeLines[i] = codeLines[i].slice(lowestIndent);
        }
    }

    // Special case: things beginning with joint frames (else, elif, except, finally) are
    // not parsed by Skulpt as-is (because they lack the main construct before), but we
    // would like to support parsing them.  So we look for them and try gluing on
    // the mandatory first part (if, try) then if the only parsed thing is the single compound
    // frame (because we don't want to allow else, then some other arbitrary frames)
    // then we take off the head and keep the rest.

    // 0 if we added none, 1 if we added only a parent, 2 if we add a parent and an initial join:
    let addedFakeJoinParent = 0;
    // So, find first word of first non-blank line:
    const firstNonBlank = codeLines.find((l) => l.trim() != "");
    if (firstNonBlank) {
        const leadingIndent = firstNonBlank.replace(/[^ ].*/, "");
        const firstWord = firstNonBlank.replace(/[^a-z].*/, "");
        switch(firstWord) {
        case "elif":
            // We glue an if on:
            codeLines.unshift(leadingIndent + "if True:\n", leadingIndent + "    pass\n");
            addedFakeJoinParent = 1;
            break;
        // So else can actually be with "if" or "try".  We take advantage of the fact that if it's with
        // "if", nothing valid can follow an else.  So it will always be the last item.  With "try"
        // that's not the case.  But if we always glue a "try" on the front, it will work for the solitary-else
        // case for "if", and it will work with "try".  So we do that:
        case "else":
        case "except":
        case "finally":
            // We glue a try on.  We must also glue on an except, because actually "else" is only valid if it follows an "except",
            // and all three are valid to follow a try/except.
            codeLines.unshift(leadingIndent + "try:\n", leadingIndent + "    pass\n", leadingIndent + "except:\n", leadingIndent + "    pass\n");
            addedFakeJoinParent = 2;
            break;
        }
    }
        
    // Have to configure Skulpt even though we're only using it for parsing:
    Sk.configure({});
    let parsed;
    try {
        parsed = Sk.parse("pasted_content.py", codeLines.join("\n"));
    }
    catch (e) {
        return ((e as any).$offset?.v?.[2]?.$mangled ?? (e as any).$msg?.$mangled) + " line: " + mapLineno((e as any).traceback?.[0].lineno);
    }
    const parsedBySkulpt = parsed["cst"];
    
    // Skulpt doesn't preserve blanks or comments so we must find them then later reinsert them
    // ourselves at the right points:
    // Find all comments.  This isn't quite perfect (with respect to # in strings) but it will do:
    const comments : LocatedCommentOrBlankLine[] = [];
    for (let i = 0; i < codeLines.length; i++) {
        // Look for # with only space before them, or a # with no quote after:
        const match = /^ +#(.*)$/.exec(codeLines[i]) ?? /#([^"]+)$/.exec(codeLines[i]);
        if (match) {
            comments.push({lineNumber: i + 1, content: match[1]});
        }
        else if (codeLines[i].trim() === "") {
            // Blank line:
            comments.push({lineNumber: i + 1, content: null});
        }
    }
    
    useStore().copiedFrames = {};
    useStore().copiedSelectionFrameIds = [];
    try {
        // Use the next available ID to avoid clashing with any existing IDs:
        copyFramesFromPython(parsedBySkulpt, {nextId: useStore().nextAvailableId, addTo: useStore().copiedSelectionFrameIds, pendingComments: comments, parent: null});
        // At this stage, we can make a sanity check that we can copy the given Python code in the current position in Strype (for example, no "import" in a function definition section)
        if(!canPastePythonAtStrypeLocation(currentStrypeLocation)){
            useStore().copiedFrames = {};
            useStore().copiedSelectionFrameIds = [];
            return i18n.t("messageBannerMessage.incompatiblePythonStrypeSection") as string;
        }

        if (addedFakeJoinParent > 0) {
            // Now have to detach that parent again.  If it was joint frames only, there should be one parent on the list:
            if (useStore().copiedSelectionFrameIds.length == 1) {
                // Clone the list to avoid modification issues:
                useStore().copiedSelectionFrameIds = [...useStore().copiedFrames[useStore().copiedSelectionFrameIds[0]].jointFrameIds.slice(addedFakeJoinParent - 1)];
            }
            else {
                // Uh-oh, they had other things after the else, etc.  We can't handle that, so abandon:
                useStore().copiedFrames = {};
                useStore().copiedSelectionFrameIds = [];
                return i18n.t("messageBannerMessage.wrongPythonStructCopied") as string;
            }
        }
        return null;
    }
    catch (e) {
        console.log(e); // + "On:\n" + debugToString(parsedBySkulpt, "  "));
        // Don't leave partial content:
        useStore().copiedFrames = {};
        useStore().copiedSelectionFrameIds = [];
        return ((e as any).$offset?.v?.[2]?.$mangled ?? (e as any).$msg?.$mangled) + " line: " + mapLineno((e as any).traceback?.[0].lineno);
    }
}

// Concatenates two slot structures with the given operator.
// Eliminates any redundant blank operators.
function concatSlots(lhs: SlotsStructure, operator: string, rhs: SlotsStructure) : SlotsStructure {
    const joined = {fields: [...lhs.fields, ...rhs.fields], operators: [...lhs.operators, {code: operator}, ...rhs.operators]};
    // Eliminate any redundant blank operators (i.e. those where the RHS or RHS is a non-bracketed blank:
    for (let i = 0; i < joined.operators.length; i++) {
        if (joined.operators[i].code === "") {
            // Check LHS and RHS:
            if (!(joined.fields[i] as SlotsStructure)?.openingBracketValue && !(joined.fields[i] as StringSlot)?.quote && !(joined.fields[i+1] as SlotsStructure)?.openingBracketValue && !(joined.fields[i+1] as StringSlot)?.quote) {
                // We can join the two:
                joined.fields[i] = {code: (joined.fields[i] as BaseSlot).code + (joined.fields[i+1] as BaseSlot).code};
                joined.fields.splice(i + 1, 1);
                joined.operators.splice(i, 1);
                // Make us re-examine operator i:
                i -= 1;
                continue;
            }
        }
    }
    return joined;
}

// Dig down the tree and find the actual value.  Skips down through
// all parents with a single child.  If there is no value or no children,
// an error will be thrown.  This shouldn't happen for the items we are
// calling it on (operators, numeric literals).
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

// The state while parsing a long expression with multiple operands and operators:
interface ParseState {
    seq: ParsedConcreteTree[];
    nextIndex: number;
}

// The index of ParseState will be modified in the given item:
function parseNextTerm(ps : ParseState) : SlotsStructure {
    // Check for unary operator:
    const nextVal = ps.seq[ps.nextIndex].value;
    if (nextVal === "-" || nextVal === "+") {
        // Unary numbers just go in their own field:
        try {
            const valAfterThat = digValue(ps.seq[ps.nextIndex + 1]);
            if (/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(valAfterThat)) {
                ps.nextIndex += 2;
                return {fields: [{code: nextVal + valAfterThat}], operators: []};
            }
        }
        catch (e) {
            // Not an integer then...
        }
        
        ps.nextIndex += 1;
        return concatSlots({fields: [{code: ""}], operators: []}, nextVal, parseNextTerm(ps));
    }
    if (nextVal === "not" || nextVal === ":") {
        ps.nextIndex += 1;
        return concatSlots({fields: [{code: ""}], operators: []}, nextVal, parseNextTerm(ps));
    }
    const term = ps.seq[ps.nextIndex];
    ps.nextIndex += 1;
    return toSlots(term);
}

function toSlots(p: ParsedConcreteTree) : SlotsStructure {
    // Handle terminal nodes by just plonking them into a single-field slot:
    if (p.children == null || p.children.length == 0) {
        const val = p.value ?? "";
        if (val.startsWith("\"") || val.startsWith("'")) {
            const str : StringSlot = {code: val.slice(1, val.length - 1), quote: val.slice(0, 1)};
            return {fields: [{code: ""}, str, {code: ""}], operators: [{code: ""}, {code: ""}]};
        }
        else {
            return {fields: [{code: val}], operators: []};
        }
    }
    
    // Skulpt's parser seems to output a huge amount of dummy nodes with one child,
    // e.g. an OR inside an AND.  We have a catch-all that just descends if there's only one child:
    if (p.children.length == 1) {
        return toSlots(p.children[0]);
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

    const ps = {seq: p.children, nextIndex: 0};
    let latest = parseNextTerm(ps);
    while (ps.nextIndex < p.children.length) {
        const child = p.children[ps.nextIndex];
        if (child.type === Sk.ParseTables.sym.trailer) {
            // A suffix, like an array index lookup.  Join it and move forward only by one:
            const grandchildren = child.children;
            if (grandchildren != null && grandchildren[0].value === ".") {
                latest = concatSlots(latest, ".", toSlots(grandchildren[1]));
            }
            else {
                // Something bracketed:
                latest = concatSlots(latest, "", toSlots(child));
            }
            ps.nextIndex += 1;
            continue;
        }
        // Now we expect a binary operator:        
        let op;
        try {
            op = digValue(child);
            ps.nextIndex += 1;
        }
        catch (err) {
            throw new Error("Cannot find operator " + ps.nextIndex + " in:\n" + debugToString(p, ""), {cause: err});
        }
        if (op != null && (operators.includes(op) || trimmedKeywordOperators.includes(op))) {
            if (op == ":" && ps.nextIndex == ps.seq.length) {
                // Can be blank on RHS of colon
                latest = concatSlots(latest, op, {fields: [{code: ""}], operators: []});
            }
            else {
                latest = concatSlots(latest, op, parseNextTerm(ps));
            }
        }
        else {
            throw new Sk.builtin.SyntaxError("Unknown operator: " + child.type + " \"" + op + "\"", null, p.lineno);
        }
    }
    return latest;
}

// Get the children of the node, and throw an error if they are null.  This
// should never happen, but if we use p.children then Typescript complains everywhere
// that it could be null, whereas children(p) satisfies Typescript and gives a useful
// error if it does turn out to be null.
function children(p : ParsedConcreteTree) : ParsedConcreteTree[] {
    if (p.children == null) {
        throw new Error("Null children on node " + JSON.stringify(p));
    }
    return p.children;
}

// Given an index into the children (or a sequence of indexes), apply that and get the appropriate child.
function applyIndex(p : ParsedConcreteTree, index: number | number[]) : ParsedConcreteTree {
    if (typeof(index) === "number") {
        return children(p)[index];
    }
    else {
        const initial = index[0];
        const rest = index.slice(1);
        return applyIndex(children(p)[initial], rest.length == 1 ? rest[0] : rest);
    }
}

// Make a frame using the given frame type, the given index/indices of p's children for the slots,
// the given index for the body, and call addFrame on it.
function makeAndAddFrameWithBody(p: ParsedConcreteTree, frameType: string, childrenIndicesForSlots: (number | number[])[], childIndexForBody: number, s : CopyState, afterwards? : ((f : FrameObject) => void)) : CopyState {
    const slots : { [index: number]: LabelSlotsContent} = {};
    for (let slotIndex = 0; slotIndex < childrenIndicesForSlots.length; slotIndex++) {
        slots[slotIndex] = {slotStructures : toSlots(applyIndex(p, childrenIndicesForSlots[slotIndex]))};
    }
    const frame = makeFrame(frameType, slots);
    s = addFrame(frame, s);
    const nextId = copyFramesFromPython(children(p)[childIndexForBody], {...s, addTo: frame.childrenIds, parent: frame}).nextId;
    if (afterwards !== undefined) {
        afterwards(frame);
    }
    return {...s, nextId: nextId};
}

// Check if there any comments/blanks in s.pendingComments that appear at or before the given line number,
// and insert them as blanks/comment frames at the given point 
function flushComments(lineno: number, s: CopyState) {
    while (s.pendingComments.length > 0 && s.pendingComments[0].lineNumber <= lineno) {
        if (s.pendingComments[0].content === null) {
            s = addFrame(makeFrame(AllFrameTypesIdentifier.blank, {}), s);
        }
        else {
            s = addFrame(makeFrame(AllFrameTypesIdentifier.comment, {0: {slotStructures: {fields: [{code: s.pendingComments[0].content}], operators: []}}}), s);
        }
        // Remove first item:
        s.pendingComments.splice(0, 1);
    }
    return s;
}

// Process the given node in the tree at the current point designed by CopyState 
// Returns a copy state, including the frame ID of the next insertion point for any following statements
function copyFramesFromPython(p: ParsedConcreteTree, s : CopyState) : CopyState {
    //console.log("Processing type: " + (Sk.ParseTables.number2symbol[p.type] || ("#" + p.type)));
    if (p.lineno) {
        s = flushComments(p.lineno, s);
    }
    
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
    case Sk.ParseTables.sym.import_stmt: 
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
                s = addFrame(makeFrame(AllFrameTypesIdentifier.funccall, {0: {slotStructures: toSlots(p)}}), s);
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
    case Sk.ParseTables.sym.global_stmt:
        s = addFrame(makeFrame(AllFrameTypesIdentifier.global, {0: {slotStructures: toSlots(children(p)[1])}}), s);
        break;
    case Sk.ParseTables.sym.import_name:
        s = addFrame(makeFrame(AllFrameTypesIdentifier.import, {0: {slotStructures: toSlots(children(p)[1])}}), s);
        break;
    case Sk.ParseTables.sym.import_from:
        s = addFrame(makeFrame(AllFrameTypesIdentifier.fromimport, {0: {slotStructures: toSlots(children(p)[1])}, 1: {slotStructures: toSlots(children(p)[3])}}), s);
        break;
    case Sk.ParseTables.sym.raise_stmt:
        s = addFrame(makeFrame(AllFrameTypesIdentifier.raise, {0: {slotStructures: toSlots(children(p)[1])}}), s);
        break;
    case Sk.ParseTables.sym.return_stmt:
        // Return may or may not have an expression child after it:
        if (children(p).length >= 2) {
            s = addFrame(makeFrame(AllFrameTypesIdentifier.return, {0: {slotStructures: toSlots(children(p)[1])}}), s);
        }
        else {
            s = addFrame(makeFrame(AllFrameTypesIdentifier.return, {0: {slotStructures: {fields: [{code: ""}], operators: []}}}), s);
        }
        break;
    case Sk.ParseTables.sym.if_stmt: {
        // First child is keyword, second is the condition, third is colon, fourth is body
        const ifFrame: FrameObject[] = [];
        s = makeAndAddFrameWithBody(p, AllFrameTypesIdentifier.if, [1], 3, s, (f : FrameObject) => ifFrame.push(f));
        // If can have elif, else, so keep going to check for that:
        for (let i = 4; i < children(p).length; i++) {
            if (children(p)[i].value === "else") {
                // Skip the else and the colon, which are separate tokens:
                i += 2;
                s.nextId = makeAndAddFrameWithBody(p, AllFrameTypesIdentifier.else, [], i, {...s, addTo: ifFrame[0].jointFrameIds, parent: null}, (f) => {
                    f.jointParentId = ifFrame[0].id;
                }).nextId;
            }
            else if (children(p)[i].value === "elif") {
                // Skip the elif:
                i += 1;
                s.nextId = makeAndAddFrameWithBody(p, AllFrameTypesIdentifier.elif, [i], i + 2, {...s, addTo: ifFrame[0].jointFrameIds, parent: null}, (f) => {
                    f.jointParentId = ifFrame[0].id;
                }).nextId;
                // Skip the condition and the colon:
                i += 2;
            }
        }
        break;
    }
    case Sk.ParseTables.sym.while_stmt:
        // First child is keyword, second is the condition, third is colon, fourth is body
        s = makeAndAddFrameWithBody(p, AllFrameTypesIdentifier.while, [1], 3, s);
        break;
    case Sk.ParseTables.sym.for_stmt:
        // First child is keyword, second is the loop var, third is keyword, fourth is collection, fifth is colon, sixth is body
        s = makeAndAddFrameWithBody(p, AllFrameTypesIdentifier.for, [1, 3], 5, s);
        break;
    case Sk.ParseTables.sym.try_stmt: {
        // First is keyword, second is colon, third is body
        const tryFrame : FrameObject[] = [];
        s = makeAndAddFrameWithBody(p, AllFrameTypesIdentifier.try, [], 2, s, (f) => tryFrame.push(f));
        // The except clauses are descendants of the try block, so we must iterate through later children:
        for (let i = 3; i < children(p).length; i++) {
            const child = children(p)[i];
            if (child.type === Sk.ParseTables.sym.except_clause) {
                // The first child is except keyword.  Everything else is optional, so we have three options:
                // - Blank except
                // - Except with single argument
                // - Except with "x as y" (which we shove into one slot)
                const grandchildren = children(child);
                let exceptFrame;
                if (grandchildren.length == 4 && grandchildren[2].value === "as") {
                    // except ErrorType as varName:
                    exceptFrame = makeFrame(AllFrameTypesIdentifier.except, {0: {slotStructures:
                                concatSlots(toSlots(grandchildren[1]), "as", toSlots(grandchildren[3])),
                    }});
                }
                else if (grandchildren.length == 2) {
                    // except varName:
                    exceptFrame = makeFrame(AllFrameTypesIdentifier.except, {0: {slotStructures: toSlots(grandchildren[1])}});
                }
                else if (grandchildren.length == 1) {
                    // Just the except keyword, i.e. blank except:
                    exceptFrame = makeFrame(AllFrameTypesIdentifier.except, {0: {slotStructures: {fields: [{code: ""}], operators: []}}});
                }
                else {
                    // Shouldn't happen, but skip if so:
                    continue;
                }
                exceptFrame.jointParentId = tryFrame[0].id;
                s.nextId = addFrame(exceptFrame, {...s, addTo: tryFrame[0].jointFrameIds, parent: null}).nextId;
                // The children of the except actually follow as a sibling of the clause, after the colon (hence i + 2):
                s.nextId = copyFramesFromPython(children(p)[i+2], {...s, parent: exceptFrame, addTo: exceptFrame.childrenIds}).nextId;
            }
            else if (child.value === "finally") {
                // Weirdly, finally doesn't seem to have a proper node type, it's just a normal child
                // followed by a colon followed by a body
                s.nextId = makeAndAddFrameWithBody(p, AllFrameTypesIdentifier.finally, [], i + 2, {...s, addTo: tryFrame[0].jointFrameIds, parent: null}, (f) => f.jointParentId = tryFrame[0].id).nextId;
            }
            else if (child.value === "else") {
                // else is the same as finally, a normal child then colon then body:
                s.nextId = makeAndAddFrameWithBody(p, AllFrameTypesIdentifier.else, [], i + 2, {...s, addTo: tryFrame[0].jointFrameIds, parent: null}, (f) => f.jointParentId = tryFrame[0].id).nextId;
            }
        }
        break;
    }
    case Sk.ParseTables.sym.with_stmt:
        // First child is keyword, second is with_item that has [LHS, "as", RHS] as children, third is colon, fourth is body
        s = makeAndAddFrameWithBody(p, AllFrameTypesIdentifier.with, [[1, 0], [1, 2]], 3, s);
        break;
    case Sk.ParseTables.sym.suite:
        // I don't really understand what this item is (it seems to have the raw content as extra children),
        // but it seems if we ignore these extra children we can proceed and it will all work:
        for (const child of children(p)) {
            if (child.type > 250) { // Only count the non-expression nodes
                s = copyFramesFromPython(child, s);
            }
        }
        break;
    case Sk.ParseTables.sym.funcdef:
        // First child is keyword, second is the name, third is params, fourth is colon, fifth is body
        s = makeAndAddFrameWithBody(p, AllFrameTypesIdentifier.funcdef, [1, 2], 4, s);
        break;
    }
    return s;
}

// Function to check the current position in Strype 
export function findCurrentStrypeLocation(): STRYPE_LOCATION {
    // We detect the location by nativagating to the parents of the current Strype location (blue cursor) until we reach a significant parent type (see enum STRYPE_LOCATION)
    // If are below a frame, we look for its parent right away, otheriwse we can use that fraome
    let navigFrameId = useStore().currentFrame.id;
    do{
        const frameType = useStore().frameObjects[navigFrameId].frameType;
        switch(frameType.type){
        case ContainerTypesIdentifiers.framesMainContainer:
            return STRYPE_LOCATION.MAIN_CODE_SECTION;
        case AllFrameTypesIdentifier.funcdef:
            return STRYPE_LOCATION.IN_FUNCDEF;
        case ContainerTypesIdentifiers.funcDefsContainer:
            return STRYPE_LOCATION.FUNCDEF_SECTION;
        case ContainerTypesIdentifiers.importsContainer:
            return STRYPE_LOCATION.IMPORTS_SECTION;
        default:
            if (useStore().frameObjects[navigFrameId].jointParentId > 0) {
                navigFrameId = useStore().frameObjects[navigFrameId].jointParentId;
            }
            else {
                navigFrameId = useStore().frameObjects[navigFrameId].parentId;
            }
            break;
        }
    }while(navigFrameId != 0);
    return STRYPE_LOCATION.UNKNOWN;
}

// This function makes a simple sanity check on the copied Python code (as frames then): we make sure that it "fits" the current Strype location
function canPastePythonAtStrypeLocation(currentStrypeLocation : STRYPE_LOCATION): boolean {
    // In more details, we check the same-leve (top level) frames in the copy:
    // - in the "import" section, only imports can be copied,
    // - in the "function definition" section, only function definitions can be copied
    // - in the "main code" section or inside a function definition frame, only code that doesn't contain imports or function definitions can be copied (and "global" for main code)
    // Comments can also be imported in all sections. 
    // We remove any blank frames that could exist for an imports or function definitions section top frames: they are not required in the editor.
    // Nevertheless, for this test method to complete, we still need to accept blanks to be inside imports and function definitions for validation.
    
    const copiedPythonToFrames = Object.values(useStore().copiedFrames);
    const topLevelCopiedFrames = copiedPythonToFrames.filter((frame) => frame.parentId == TOP_LEVEL_TEMP_ID);
    const topLevelCopiedFrameIds = topLevelCopiedFrames.flatMap((frame) => frame.id);
    // Check if the match between the current Strype location and the copied Python code frames is possible
    switch(currentStrypeLocation){
    case STRYPE_LOCATION.MAIN_CODE_SECTION:
        return !copiedPythonToFrames.some((frame) => [AllFrameTypesIdentifier.import, AllFrameTypesIdentifier.fromimport, AllFrameTypesIdentifier.funcdef, AllFrameTypesIdentifier.global].includes(frame.frameType.type));
    case  STRYPE_LOCATION.IN_FUNCDEF:
        return !copiedPythonToFrames.some((frame) => [AllFrameTypesIdentifier.import, AllFrameTypesIdentifier.fromimport, AllFrameTypesIdentifier.funcdef].includes(frame.frameType.type));
    case  STRYPE_LOCATION.FUNCDEF_SECTION:
        removeTopLevelBlankFrames();
        return !(topLevelCopiedFrames.some((frame) => ![AllFrameTypesIdentifier.funcdef, AllFrameTypesIdentifier.comment, AllFrameTypesIdentifier.blank].includes(frame.frameType.type))
            || copiedPythonToFrames.some((frame) => !topLevelCopiedFrameIds.includes(frame.id) && [AllFrameTypesIdentifier.import, AllFrameTypesIdentifier.fromimport, AllFrameTypesIdentifier.funcdef].includes(frame.frameType.type)));
    case  STRYPE_LOCATION.IMPORTS_SECTION:
        removeTopLevelBlankFrames();
        return !topLevelCopiedFrames.some((frame) => ![AllFrameTypesIdentifier.import, AllFrameTypesIdentifier.fromimport, AllFrameTypesIdentifier.comment, AllFrameTypesIdentifier.blank].includes(frame.frameType.type));
    default:
        // We shouldn't reach this but for safety we return false
        return false;
    }
}

function removeTopLevelBlankFrames(): void {
    // Remove blank frames in the first level of the copied frames. T
    // This is useful when copying Python code that had line breaks between the function defs or the imports:
    // our editor do not allow adding blank frames, so they shouldn't be kept when pasted.
    const copiedPythonToFrames = Object.values(useStore().copiedFrames);
    const topLevelCopiedFrames = copiedPythonToFrames.filter((frame) => frame.parentId == TOP_LEVEL_TEMP_ID);
    const topLevelBlankFramesIds = topLevelCopiedFrames.filter((frame) => frame.frameType.type === AllFrameTypesIdentifier.blank)
        .map((frame) => frame.id);
    topLevelBlankFramesIds.forEach((frameId) => {
        delete useStore().copiedFrames[frameId];
        useStore().copiedSelectionFrameIds.splice(useStore().copiedSelectionFrameIds.indexOf(frameId), 1);
    });
}

interface NumberedLine {
    lineno: number;
    text: string;
}

function makeMapping(section: NumberedLine[]) : Record<number, number> {
    return section.reduce((acc, item, index) => {
        acc[index + 1] = item.lineno;
        return acc;
    }, {} as Record<number, number>);
}

// Takes a list of lines of Python code and splits them into three sections: imports, function definitions, and main code.
// Each line of the original will end up in exactly one of the three parts of the return.
// With Python's indentation rules, this operation is actually easier at line level than it is post-parse.
// The mappings map line numbers in the returned sections to line numbers in the original
export function splitLinesToSections(allLines : string[]) : {imports: string[]; defs: string[]; main: string[], importsMapping: Record<number, number>, defsMapping: Record<number, number>, mainMapping: Record<number, number>} {
    // We associate comments with the line immediately following them, so we keep a list of the most recent comments:
    let latestComments: NumberedLine[] = [];
    const imports: NumberedLine[] = [];
    const defs: NumberedLine[] = [];
    const main: NumberedLine[] = [];
    let addingToDef = false;
    allLines.forEach((line : string, zeroBasedLine : number) => {
        const lineWithNum : NumberedLine = {text: line, lineno: zeroBasedLine + 1};
        if (line.match(/^(import|from)\s+/)) {
            // Import:
            imports.push(...latestComments);
            latestComments = [];
            imports.push(lineWithNum);
            addingToDef = false;
        }
        else if (line.match(/^def\s+/)) {
            defs.push(...latestComments);
            latestComments = [];
            defs.push(lineWithNum);
            addingToDef = true;
        }
        else if (line.match(/^\s*#/)) {
            latestComments.push(lineWithNum);
        }
        else if (addingToDef && !line.match(/^\S/)) {
            // Keep adding to defs until we see a non-comment line with zero indent:
            defs.push(...latestComments);
            latestComments = [];
            defs.push(lineWithNum);
        }
        else {
            addingToDef = false;
            main.push(...latestComments);
            latestComments = [];
            main.push(lineWithNum);
        }
    });
    // Add any trailing comments:
    main.push(...latestComments);
    return {
        imports: imports.map((l) => l.text),
        defs: defs.map((l) => l.text),
        main: main.map((l) => l.text),
        importsMapping : makeMapping(imports),
        defsMapping : makeMapping(defs),
        mainMapping : makeMapping(main),
    };
}
