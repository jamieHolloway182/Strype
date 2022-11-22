import i18n from "@/i18n";
import Compiler from "@/compiler/compiler";
import { useStore } from "@/store/store";

// Type Definitions

/**
 *  NOTE that all "primitive" types start with a lower-case as this is the way TS works.
 */

export interface LabelSlotsContent {
    shown?: boolean; // default is true (indicate if the label/slots are currently shown at all, for example "as" part for import frame)
    slotStructures: SlotsStructure; // the root slot for that label
}

export type FieldSlot = (BaseSlot | SlotsStructure | StringSlot);
export interface SlotsStructure {
    operators: BaseSlot[];
    fields: FieldSlot[];
    openingBracketValue?: string;
}

export interface BaseSlot {
    code: string;
    focused?: boolean; // default false
    error?: string; // default ""
    errorTitle?: string; // default ""
    isEmphasised?: boolean; // false by default
}

export interface StringSlot extends BaseSlot {
    quote: string;    
}

export interface FlatSlotBase extends BaseSlot{    
    id: string;
    type: SlotType;
}

export function isFieldStringSlot(field: FieldSlot): field is StringSlot {
    return (field as StringSlot).quote !== undefined;
}

export function isFieldBracketedSlot(field: FieldSlot): field is SlotsStructure {
    return (field as SlotsStructure).openingBracketValue !== undefined;
}

export function isFieldBaseSlot(field: FieldSlot): field is BaseSlot {
    return (!isFieldBracketedSlot(field) && !isFieldStringSlot(field));
}

// Used by the UI and in the code-behind mechanisms
// The types have "meta" categories and detailed categories, valued so we can easily
// get the meta category from a detailed category.
export enum SlotType{
    // code types
    code = 0o0007, // meta category
    string = 0o0001, // detail: a string
    number = 0o0002, // detail: an number
    bool = 0o0003, // detail: a boolean
    // quotes for string types
    quote = 0o0070, // meta category
    openingQuote = 0o0010, // detail for the opening one
    closingQuote = 0o0020, // detail for the closing one
    // brackets type
    bracket = 0o0700, //meta category
    openingBracket = 0o0100, // detail for the opening one
    closingBracket = 0o0200,// detail for the closing one
    // operator type
    operator = 0o7000, // meta category
    
}

export function isSlotCodeType(type: SlotType): boolean {
    return (type & SlotType.code) > 0;
}

export function isSlotQuoteType(type: SlotType): boolean {
    return (type & SlotType.quote) > 0;
}

export function isSlotBracketType(type: SlotType): boolean {
    return (type & SlotType.bracket) > 0;
}

export interface EditorFrameObjects {
    [id: number]: FrameObject;
}

// Frame related interace, the highest level to describe a frame
// Note the labelSlotsDict property is an array inline with each label of the frame
// and slots are always related to 1 label (for example "for" (label 0) and "in" (label 1) in a for frame)
export interface FrameObject {
    frameType: FramesDefinitions;
    id: number;
    isDisabled: boolean;
    isSelected: boolean;
    isVisible: boolean;
    isCollapsed?: boolean;
    parentId: number; //this is the ID of a parent frame (example: the if frame of a inner while frame). Value can be 0 (root), 1+ (in a level), -1 for a joint frame
    childrenIds: number[]; //this contains the IDs of the children frames
    jointParentId: number; //this is the ID of the first sibling of a joint frame (example: the if frame of a elif frame under that if), value can be -1 if none, 1+ otherwise
    jointFrameIds: number[]; //this contains the IDs of the joint frames
    caretVisibility: CaretPosition;
    labelSlotsDict: { [index: number]: LabelSlotsContent}; //this contains the label input slots data listed as a key value pairs array (key = index of the slot)
    multiDragPosition: string;
    runTimeError?: string; //this contains the error message for a runtime error, as the granularity of the Skulpt doesn't go beyond the line number
}

export interface FrameLabel {
    label: string;
    hidableLabelSlots?: boolean; // default false, true indicate that this label and associated slots can be hidden (ex: "as" in import frame)
    showLabel?: boolean; // default true, indicates if the label is showned (ex method call frame has no label text)
    showSlots?: boolean; // default true, false indicates that the label has no slot to be associated with it (for example label ":" in "if <xxx> :")
    defaultText: string;
    optionalSlot?: boolean; //default false (indicate that this label does not require at least 1 slot value)
    acceptAC?: boolean; //default true
}


// There are three groups of draggable frames.
// You can drag from the main code to the body of a method and vice-versa, 
// but you cannot drag from/to imports or drag method signatures
export enum DraggableGroupTypes {
    imports = "imports",
    code = "code",
    functionSignatures = "functionSignatures",
    ifCompound = "ifCompound",
    tryCompound = "tryCompound",
    shadowEditorContainer = "editor", // This draggable is used for cursor management - a root of all other draggables (cf. handleDraggingCursor())
    none = "none",
}

export enum CaretPosition {
    body = "caretBody",
    below = "caretBelow",
    none = "none",
}

export interface CurrentFrame {
    id: number;
    caretPosition: CaretPosition;
}

export interface LabelSlotsPositions {
    slotStarts: number[];
    slotLengths: number[];
    slotIds: string[];
    slotTypes: SlotType[];
}

export interface LabelSlotPositionsAndCode extends LabelSlotsPositions {
    code: string;
}

export interface LineAndSlotPositions {
    // Index is the line number, and for each labels, we hold the slot starts and lengths
    [line: number]: {
        frameId: number ; 
        labelSlotStartLengths: {[labelIndex: number]: LabelSlotsPositions}};
}

export interface SlotCoreInfos {
    frameId: number;
    labelSlotsIndex: number;
    slotId: string;
    slotType: SlotType;
}

export function areSlotCoreInfosEqual(slotInfos1: SlotCoreInfos, slotInfos2: SlotCoreInfos): boolean {
    // For types, we don't do a straight forward comparison: code types comparison is dont weakly, for example "SlotType.code" and "SlotType.number"
    // will be considered as equal.
    const areTypesEquivalent = (isSlotCodeType(slotInfos1.slotType)) ? isSlotCodeType(slotInfos2.slotType) : (slotInfos1.slotType == slotInfos2.slotType);
    return (slotInfos1.frameId == slotInfos2.frameId
        && slotInfos1.labelSlotsIndex == slotInfos2.labelSlotsIndex
        && slotInfos1.slotId == slotInfos2.slotId
        && areTypesEquivalent);
}

export interface SlotInfos extends SlotCoreInfos {
    code: string;
    initCode: string;
    isFirstChange: boolean;
    error?: string;
    errorTitle?: string;
}

export interface SlotCursorInfos{
    slotInfos: SlotCoreInfos;
    cursorPos: number;
}

export interface EditableFocusPayload extends SlotCoreInfos {
    focused: boolean;
}

export interface NavigationPosition {
    frameId: number;
    isSlotNavigationPosition: boolean, // flag to indicate if we are working with a slot position (change from previous version that used composite types)
    caretPosition?: string;
    labelSlotsIndex?: number;
    slotId?: string;
}
export interface AddFrameCommandDef {
    type: FramesDefinitions;
    description: string; // The label that shown next to the key shortcut button
    shortcut: string; // The keyboard key shortcut to be used to add a frame (eg "i" for an if frame)
    symbol?: string; // The symbol to show in the key shortcut button when the key it's not easily reprenstable (e.g. "⌴" for space)
    tooltip: string; // If needed, the tooltip content that explains the role of a frame - localised
    index?: number; // the index of frame type when a shortcut matches more than 1 context-distinct frames
}

// This is an array with all the frame Definitions objects.
// Note that the slot variable of each objects tells if the
// Label needs an editable slot as well attached to it.
export interface FramesDefinitions {
    type: string;
    labels: FrameLabel[];
    allowChildren: boolean;
    allowJointChildren: boolean;
    forbiddenChildrenTypes: string[];
    isJointFrame: boolean;
    jointFrameTypes: string[];
    colour: string;
    isCollapsed?: boolean;
    draggableGroup: DraggableGroupTypes;
    innerJointDraggableGroup: DraggableGroupTypes;
    isImportFrame: boolean;
}

// Identifiers of the containers
export const ContainerTypesIdentifiers = {
    root: "root",
    importsContainer: "importsContainer",
    funcDefsContainer: "funcDefsContainer",
    framesMainContainer: "mainContainer",
};

const CommentFrameTypesIdentifier = {
    comment: "comment",
};
// Identifiers of the frame types
const ImportFrameTypesIdentifiers = {
    import: "import",
    fromimport: "from-import",
};

const FuncDefIdentifiers = {
    funcdef: "funcdef",
};

export const JointFrameIdentifiers = {
    elif: "elif",
    else: "else",
    except: "except",
    finally: "finally",
};

const StandardFrameTypesIdentifiers = {
    ...CommentFrameTypesIdentifier,
    empty: "",
    if: "if",
    for: "for",
    while: "while",
    break: "break",
    continue: "continue",
    try: "try",
    raise: "raise",
    with: "with",
    return: "return",
    varassign: "varassign",
    global: "global",
    ...JointFrameIdentifiers,
};

export const AllFrameTypesIdentifier = {
    ...ImportFrameTypesIdentifiers,
    ...FuncDefIdentifiers,
    ...StandardFrameTypesIdentifiers,
};

export const DefaultFramesDefinition: FramesDefinitions = {
    type: StandardFrameTypesIdentifiers.empty,
    labels: [],
    allowChildren: false,
    allowJointChildren: false,
    forbiddenChildrenTypes: [],
    isJointFrame: false,
    jointFrameTypes: [],
    colour: "",
    draggableGroup: DraggableGroupTypes.none,
    innerJointDraggableGroup: DraggableGroupTypes.none,
    isImportFrame: false,
};

export const BlockDefinition: FramesDefinitions = {
    ...DefaultFramesDefinition,
    allowChildren: true,
    forbiddenChildrenTypes: Object.values(ImportFrameTypesIdentifiers)
        .concat(Object.values(FuncDefIdentifiers))
        .concat([StandardFrameTypesIdentifiers.else, StandardFrameTypesIdentifiers.elif, StandardFrameTypesIdentifiers.except, StandardFrameTypesIdentifiers.finally]),
    draggableGroup: DraggableGroupTypes.code,
};

export const StatementDefinition: FramesDefinitions = {
    ...DefaultFramesDefinition,
    forbiddenChildrenTypes: Object.values(AllFrameTypesIdentifier),
    draggableGroup: DraggableGroupTypes.code,
};

// Container frames
export const RootContainerFrameDefinition: FramesDefinitions = {
    ...BlockDefinition,
    type: ContainerTypesIdentifiers.root,
    draggableGroup: DraggableGroupTypes.none,
};

export const ImportsContainerDefinition: FramesDefinitions = {
    ...BlockDefinition,
    type: ContainerTypesIdentifiers.importsContainer,
    labels: [
        { label: (i18n.t("appMessage.importsContainer") as string), showSlots: false, defaultText: ""},
    ],
    isCollapsed: false,
    forbiddenChildrenTypes: Object.values(AllFrameTypesIdentifier)
        .filter((frameTypeDef: string) => !Object.values(ImportFrameTypesIdentifiers).includes(frameTypeDef) && frameTypeDef !== CommentFrameTypesIdentifier.comment),
    colour: "#BBC6B6",
    draggableGroup: DraggableGroupTypes.imports,
};

export const FuncDefContainerDefinition: FramesDefinitions = {
    ...BlockDefinition,
    type: ContainerTypesIdentifiers.funcDefsContainer,
    labels: [
        { label: (i18n.t("appMessage.funcDefsContainer") as string), showSlots: false, defaultText: ""},
    ],
    isCollapsed: false,
    forbiddenChildrenTypes: Object.values(AllFrameTypesIdentifier)
        .filter((frameTypeDef: string) => !Object.values(FuncDefIdentifiers).includes(frameTypeDef) && frameTypeDef !== CommentFrameTypesIdentifier.comment),
    colour: "#BBC6B6",
    draggableGroup: DraggableGroupTypes.functionSignatures,

};

export const MainFramesContainerDefinition: FramesDefinitions = {
    ...BlockDefinition,
    type: ContainerTypesIdentifiers.framesMainContainer,
    labels: [
        { label: (i18n.t("appMessage.mainContainer") as string), showSlots: false, defaultText: ""},
    ],
    isCollapsed: false,
    forbiddenChildrenTypes: BlockDefinition.forbiddenChildrenTypes.concat(Object.values(AllFrameTypesIdentifier)
        .filter((frameTypeDef: string) => !Object.values(StandardFrameTypesIdentifiers).includes(frameTypeDef))),
    colour: "#BBC6B6",
};


export const FrameContainersDefinitions = {
    RootContainerFrameDefinition,
    ImportsContainerDefinition,
    FuncDefContainerDefinition,
    MainFramesContainerDefinition,
};

let Definitions = {};

// Entry point for generating the frame definition types -- only doing so to allow dynamic localisation bits...
export function generateAllFrameDefinitionTypes(regenerateExistingFrames?: boolean): void{
    /*1) prepare all the frame definition types */
    // Blocks
    const IfDefinition: FramesDefinitions = {
        ...BlockDefinition,
        type: StandardFrameTypesIdentifiers.if,
        labels: [
            { label: "if ", defaultText: i18n.t("frame.defaultText.condition") as string},
            { label: " :", showSlots: false, defaultText: ""},
        ],
        allowJointChildren: true,
        jointFrameTypes: [StandardFrameTypesIdentifiers.elif, StandardFrameTypesIdentifiers.else],
        colour: "#E0DFE4",
        innerJointDraggableGroup: DraggableGroupTypes.ifCompound,
        forbiddenChildrenTypes: Object.values(ImportFrameTypesIdentifiers)
            .concat(Object.values(FuncDefIdentifiers))
            .concat([ StandardFrameTypesIdentifiers.except, StandardFrameTypesIdentifiers.finally]),
    };

    const ElifDefinition: FramesDefinitions = {
        ...BlockDefinition,
        type: StandardFrameTypesIdentifiers.elif,
        labels: [
            { label: "elif ", defaultText: i18n.t("frame.defaultText.condition") as string},
            { label: " :", showSlots: false, defaultText: ""},
        ],
        draggableGroup: DraggableGroupTypes.ifCompound,
        isJointFrame: true,
        jointFrameTypes: [StandardFrameTypesIdentifiers.elif, StandardFrameTypesIdentifiers.else],
    };

    const ElseDefinition: FramesDefinitions = {
        ...BlockDefinition,
        type: StandardFrameTypesIdentifiers.else,
        labels: [{ label: "else :", showSlots: false, defaultText: ""}],
        draggableGroup: DraggableGroupTypes.ifCompound,
        isJointFrame: true,
        jointFrameTypes: [StandardFrameTypesIdentifiers.finally],
    };

    const ForDefinition: FramesDefinitions = {
        ...BlockDefinition,
        type: StandardFrameTypesIdentifiers.for,
        labels: [
            { label: "for ", defaultText: i18n.t("frame.defaultText.identifier") as string, acceptAC: false},
            { label: " in ", defaultText: i18n.t("frame.defaultText.list") as string},
            { label: " :", showSlots: false, defaultText: ""},
        ],
        allowJointChildren: true,
        jointFrameTypes:[StandardFrameTypesIdentifiers.else],
        colour: "#E4D6CE",
    };

    const WhileDefinition: FramesDefinitions = {
        ...BlockDefinition,
        type: StandardFrameTypesIdentifiers.while,
        labels: [
            { label: "while ", defaultText: i18n.t("frame.defaultText.condition") as string},
            { label: " :", showSlots: false, defaultText: ""},
        ],
        colour: "#E4D5D5",
    };

    const TryDefinition: FramesDefinitions = {
        ...BlockDefinition,
        type: StandardFrameTypesIdentifiers.try,
        labels: [{ label: "try :", showSlots: false, defaultText: ""}],
        allowJointChildren: true,
        jointFrameTypes: [StandardFrameTypesIdentifiers.except, StandardFrameTypesIdentifiers.else, StandardFrameTypesIdentifiers.finally],
        colour: "#C7D9DC",
        innerJointDraggableGroup: DraggableGroupTypes.tryCompound,
    };

    const ExceptDefinition: FramesDefinitions = {
        ...BlockDefinition,
        type: StandardFrameTypesIdentifiers.except,
        labels: [
            { label: "except ", defaultText: i18n.t("frame.defaultText.exception") as string, optionalSlot: true},
            { label: " :", showSlots: false, defaultText: ""},
        ],
        jointFrameTypes: [StandardFrameTypesIdentifiers.except, StandardFrameTypesIdentifiers.else, StandardFrameTypesIdentifiers.finally],
        colour: "",
        isJointFrame: true,
        draggableGroup: DraggableGroupTypes.tryCompound,
    };

    const FinallyDefinition: FramesDefinitions = {
        ...BlockDefinition,
        type: StandardFrameTypesIdentifiers.finally,
        labels: [
            { label: "finally :", showSlots: false, defaultText: ""},
        ],
        colour: "",
        isJointFrame: true,
        draggableGroup: DraggableGroupTypes.none,
    };

    const FuncDefDefinition: FramesDefinitions = {
        ...BlockDefinition,
        type: FuncDefIdentifiers.funcdef,
        labels: [
            { label: "def ", defaultText: i18n.t("frame.defaultText.name") as string, acceptAC: false},
            { label: "(", defaultText: i18n.t("frame.defaultText.parameters") as string, optionalSlot: true, acceptAC: false},
            { label: ") :", showSlots: false, defaultText: ""},
        ],
        colour: "#ECECC8",
        draggableGroup: DraggableGroupTypes.functionSignatures,
    };

    const WithDefinition: FramesDefinitions = {
        ...BlockDefinition,
        type: StandardFrameTypesIdentifiers.with,
        labels: [
            { label: "with ", defaultText: i18n.t("frame.defaultText.expression") as string},
            { label: " as ", defaultText: i18n.t("frame.defaultText.identifier") as string},
            { label: " :", showSlots: false, defaultText: ""},
        ],
        colour: "#ede8f2",
    };

    // Statements
    const EmptyDefinition: FramesDefinitions = {
        ...StatementDefinition,
        type: StandardFrameTypesIdentifiers.empty,
        labels: [{ label: "testss", defaultText: i18n.t("frame.defaultText.funcCall") as string, showLabel: false, optionalSlot: true}],
        colour: "#F6F2E9",
    };

    const ReturnDefinition: FramesDefinitions = {
        ...StatementDefinition,
        type: StandardFrameTypesIdentifiers.return,
        labels: [{ label: "return ", defaultText: i18n.t("frame.defaultText.expression") as string, optionalSlot: true}],
        colour: "#F6F2E9",
    };

    const GlobalDefinition: FramesDefinitions = {
        ...StatementDefinition,
        type: StandardFrameTypesIdentifiers.global,
        labels: [{ label: "global ", defaultText: i18n.t("frame.defaultText.variable") as string}],
        colour: "#F6F2E9",
    };

    const VarAssignDefinition: FramesDefinitions = {
        ...StatementDefinition,
        type: StandardFrameTypesIdentifiers.varassign,
        labels: [
            { label: "", defaultText: i18n.t("frame.defaultText.identifier") as string},
            { label: " &#x21D0; ", defaultText: i18n.t("frame.defaultText.value") as string},
        ],
        colour: "#F6F2E9",
    };

    const BreakDefinition: FramesDefinitions = {
        ...StatementDefinition,
        type: StandardFrameTypesIdentifiers.break,
        labels: [
            { label: "break", showSlots: false, defaultText: "" },
        ],
        colour: "#F6F2E9",
    };

    const ContinueDefinition: FramesDefinitions = {
        ...StatementDefinition,
        type: StandardFrameTypesIdentifiers.continue,
        labels: [
            { label: "continue", showSlots: false, defaultText: "" },
        ],
        colour: "#F6F2E9",
    };

    const RaiseDefinition: FramesDefinitions = {
        ...StatementDefinition,
        type: StandardFrameTypesIdentifiers.raise,
        labels: [
            { label: "raise ", defaultText: i18n.t("frame.defaultText.exception") as string, optionalSlot: true },
        ],
        colour: "#F6F2E9",
    };

    const ImportDefinition: FramesDefinitions = {
        ...StatementDefinition,
        type: ImportFrameTypesIdentifiers.import,
        labels: [
            { label: "import ", defaultText: i18n.t("frame.defaultText.modulePart") as string},
            // The as slot to be used in a future version, as it seems that Brython does not understand the shortcut the as is creating
            // and thus not giving us back any AC results on the shortcut
            //{ label: "as ", hidableLabelSlots: true, defaultText: "shortcut", acceptAC: false},
        ],    
        colour: "#CBD4C8",
        draggableGroup: DraggableGroupTypes.imports,
        isImportFrame: true,
    };

    const FromImportDefinition: FramesDefinitions = {
        ...StatementDefinition,
        type: ImportFrameTypesIdentifiers.fromimport,
        labels: [
            { label: "from ", defaultText: i18n.t("frame.defaultText.module") as string},
            { label: "import ", defaultText: i18n.t("frame.defaultText.modulePart") as string},
            // The as slot to be used in a future version, as it seems that Brython does not understand the shortcut the as is creating
            // and thus not giving us back any AC results on the shortcut
            //{ label: "as ", hidableLabelSlots: true, defaultText: "shortcut", acceptAC: false},
        ],    
        colour: "#CBD4C8",
        draggableGroup: DraggableGroupTypes.imports,
        isImportFrame: true,
    };

    const CommentDefinition: FramesDefinitions = {
        ...StatementDefinition,
        type: StandardFrameTypesIdentifiers.comment,
        labels: [{ label: "# ", defaultText: i18n.t("frame.defaultText.comment") as string, optionalSlot: true, acceptAC: false}],
        colour: "#F6F2E9",
    };

    /*2) update the Defintions variable holding all the definitions */
    Definitions = {
        IfDefinition,
        ElifDefinition,
        ElseDefinition,
        ForDefinition,
        WhileDefinition,
        BreakDefinition,
        ContinueDefinition,
        RaiseDefinition,
        TryDefinition,
        ExceptDefinition,
        FinallyDefinition,
        FuncDefDefinition,
        WithDefinition,
        EmptyDefinition,
        ReturnDefinition,
        VarAssignDefinition,
        ImportDefinition,
        FromImportDefinition,
        CommentDefinition,
        GlobalDefinition,
        // also add the frame containers as we might need to retrieve them too
        ...FrameContainersDefinitions,
    };

    /*3) if required, update the types in all the frames existing in the editor (needed to update default texts and frame container labels) */
    if(regenerateExistingFrames){
        Object.values(useStore().frameObjects).forEach((frameObject: FrameObject) => {
            // For containers, we just assign the label manually again here
            switch(frameObject.frameType.type){
            case ImportsContainerDefinition.type:
                frameObject.frameType.labels[0].label = i18n.t("appMessage.importsContainer") as string;
                break;
            case FuncDefContainerDefinition.type:
                frameObject.frameType.labels[0].label = i18n.t("appMessage.funcDefsContainer") as string;
                break;
            case MainFramesContainerDefinition.type:
                frameObject.frameType.labels[0].label = i18n.t("appMessage.mainContainer") as string;
                break;
            default:
                // For all normal frames, we rely on the frame definition type                
                frameObject.frameType.labels.forEach((labelDef, index) => {
                    labelDef.defaultText = getFrameDefType(frameObject.frameType.type).labels[index].defaultText;
                });
                break;
            }
        });
    }
}

// Methods to access the dynamic frame definition types
export function getFrameDefType(key: string): FramesDefinitions{
    if(Object.values(Definitions).length == 0){
        generateAllFrameDefinitionTypes();
    }

    return Object.values(Definitions).find((frameDefinition) => ((frameDefinition as FramesDefinitions).type === key)) as FramesDefinitions;
}

export function getLoopFramesTypeIdentifiers(): string[] {
    return [StandardFrameTypesIdentifiers.for, StandardFrameTypesIdentifiers.while];
}

export const EmptyFrameObject: FrameObject = {
    frameType: DefaultFramesDefinition,
    id: -101, //default non-meaningful value - this will be overriden when frames are created
    isDisabled: false,
    isSelected: false,
    isVisible: true,
    parentId: -101, //default non-meaningful value - this will be overriden when frames are created
    childrenIds: [], //this contains the IDs of the children frames
    jointParentId: -101, //default non-meaningful value - this will be overriden when frames are created
    jointFrameIds: [], //this contains the IDs of the joint frames
    caretVisibility: CaretPosition.none,
    labelSlotsDict: { },
    multiDragPosition: "",
};

/**
 *  Types for the messages banner
 **/

export interface MessageButton {
    label: string;
    action: VoidFunction | string;
}

export interface FormattedMessageArgKeyValuePlaceholder {
    key: string;
    placeholderName: string;
}

export const FormattedMessageArgKeyValuePlaceholders: {[id: string]: FormattedMessageArgKeyValuePlaceholder} = {
    error: {key:"errorMsg", placeholderName : "{error_placeholder}"},
    list: {key:"list", placeholderName : "{list_placeholder}"},
};

export interface FormattedMessage {
    path: string;
    args: { [id: string]: string};
}

export const DefaultFormattedMessage: FormattedMessage = {
    path: "",
    args: {},
};

export const MessageDefinedActions = {
    closeBanner: "close",
    undo: "undo",
};

export enum imagePaths {
    empty = "",
    transferHexFile = "transferHexFile.svg",
}

export interface MessageDefinition {
    type: string;
    message: string | FormattedMessage;
    buttons: MessageButton[];
    path: imagePaths;
}

export const MessageTypes = {
    noMessage: "none",
    largeDeletion: "largeDeletion",
    imageDisplay: "imageDisplay",
    uploadSuccessMicrobit:"uploadSuccessMicrobit",
    noUndo: "noUndo",
    noRedo: "noRedo",
    uploadEditorFileError: "uploadEditorFileError",
    uploadEditorFileNotSupported: "uploadEditorFileNotSupported",
    uploadEditorFileSucces: "uploadEditorFileSuccess",
    forbiddenFrameMove: "forbiddenFrameMove",
    functionFrameCantDelete: "functionFrameCantDelete",
    pythonInputWarning: "pythonInputWarning",
};

//empty message
const NoMessage: MessageDefinition = {
    type: MessageTypes.noMessage,
    message: "",
    buttons: [],
    path: imagePaths.empty,
};

//message for large deletation (undo)
const LargeDeletion: MessageDefinition = {
    type: MessageTypes.largeDeletion,
    message: "messageBannerMessage.deleteLargeCode",
    buttons:[{label: "buttonLabel.undo", action:MessageDefinedActions.undo}],
    path: imagePaths.empty,
};

//download hex message
const DownloadHex: MessageDefinition = {
    type: MessageTypes.imageDisplay,
    message: "",
    buttons: [],
    path: imagePaths.transferHexFile,
};

//message for upload code success in microbit progress
const UploadSuccessMicrobit: MessageDefinition = {
    type: MessageTypes.uploadSuccessMicrobit,
    message: "messageBannerMessage.uploadSuccessMicrobit",
    buttons:[],
    path: imagePaths.empty,

};

//message for upload code failure in microbit progress
const UploadFailureMicrobit: MessageDefinition = {
    type: MessageTypes.uploadSuccessMicrobit,
    message: {
        path: "messageBannerMessage.uploadFailureMicrobit",
        args: {
            [FormattedMessageArgKeyValuePlaceholders.error.key]: FormattedMessageArgKeyValuePlaceholders.error.placeholderName,
        },
    },
    buttons:[],
    path: imagePaths.empty,
};

//messages to inform the user there is no undo/redo to perfom
const NoUndo: MessageDefinition = {
    type: MessageTypes.noUndo,
    message: "messageBannerMessage.noUndo",
    buttons:[],
    path: imagePaths.empty,
};

const NoRedo: MessageDefinition = {
    type: MessageTypes.noRedo,
    message: "messageBannerMessage.noRedo",
    buttons:[],
    path: imagePaths.empty,
};

const UploadEditorFileError: MessageDefinition = {
    type: MessageTypes.uploadEditorFileError,
    message: {
        path: "messageBannerMessage.uploadEditorFileError",
        args: {
            [FormattedMessageArgKeyValuePlaceholders.error.key]: FormattedMessageArgKeyValuePlaceholders.error.placeholderName,
        },
    },
    buttons:[{label: "buttonLabel.ok", action:MessageDefinedActions.closeBanner}],
    path: imagePaths.empty,
};

const UploadEditorFileNotSupported: MessageDefinition = {
    type: MessageTypes.uploadEditorFileNotSupported,
    message: {
        path: "messageBannerMessage.uploadEditorFileNotSupported",
        args: {
            [FormattedMessageArgKeyValuePlaceholders.list.key]: FormattedMessageArgKeyValuePlaceholders.list.placeholderName,
        },
    },
    buttons:[{label: "buttonLabel.ok", action:MessageDefinedActions.closeBanner}],
    path: imagePaths.empty,
};

const UploadEditorFileSuccess: MessageDefinition = {
    type: MessageTypes.noRedo,
    message: "messageBannerMessage.uploadEditorFileSuccess",
    buttons:[],
    path: imagePaths.empty,
};

const ForbiddenFrameMove: MessageDefinition = {
    type: MessageTypes.forbiddenFrameMove,
    message: "messageBannerMessage.forbiddenFrameMove",
    buttons: [],
    path: imagePaths.empty,
};

const FunctionFrameCantDelete: MessageDefinition = {
    type: MessageTypes.functionFrameCantDelete,
    message: "messageBannerMessage.functionFrameCantDelete",
    buttons: [],
    path: imagePaths.empty,
};

const PythonInputWarning: MessageDefinition = {
    type: MessageTypes.pythonInputWarning,
    message: "messageBannerMessage.pythonInputWarning",
    buttons: [],
    path: imagePaths.empty,
};

export const MessageDefinitions = {
    NoMessage,
    LargeDeletion,
    UploadSuccessMicrobit,
    UploadFailureMicrobit,
    DownloadHex,
    NoUndo,
    NoRedo,
    UploadEditorFileError,
    UploadEditorFileNotSupported,
    UploadEditorFileSuccess,
    ForbiddenFrameMove,
    FunctionFrameCantDelete,
    PythonInputWarning,
};

//WebUSB listener
export interface WebUSBListener {
    //Callback functions called on the listener by the webUSB.ts file
    onUploadProgressHandler: {(percent: number): void};
    onUploadSuccessHandler: VoidFunction;
    onUploadFailureHandler: {(errorMsg: string): void};
}

//Object difference
export interface ObjectPropertyDiff {
    //The property path is formatted as "level1_<bool>.level2_<bool>. ... .levelN" 
    //where <bool> is a boolean flag value indicating if the corresponding level is for an array or not.
    propertyPathWithArrayFlag: string;
    //value is set to "null" to notify a deletion.
    value: any;
}

//Event at application level that requests the application "freeze"
export interface AppEvent {
    requestAttention: boolean;
    message?: string;
}

//Object that holds information on changes to perform on a frame's property
export interface ChangeFramePropInfos {
    //indicated whether the propery should be changed
    changeDisableProp: boolean;
    //indicates what value the property should be changed to (one flag per type)
    newBoolPropVal?: boolean;
    newNumberPropVal?: number;
    newStringPropVal?: string;
}

//Autocompletion
export interface LanguageDef {
    builtin: ElementDef[];
    libraries: ElementDef[];
    userDefinitions: ElementDef[];
}

export interface AliasesPath {
    //return a hash of alias name / path in modules definitions
    [alias: string]: string;
     //light = module_moduleA.module_moduleB.moduleC.methodA
}
export interface ElementDef {
    name: string;
    kind: "module" | "class" | "method" | "variable" | "constructor" | "keyword";
    elements?: ElementDef[];
    argsNum?: number;
    argsName?: string[];
    argsOptional?: boolean[];
    type?: string; //return type for methods, type of obj for variables
    needNS?: boolean; // this flag indicates if a module name needs to be used within the code (ex for "import microbit", users need to write "microbit.xxxx" in code)
    hide?: boolean; //if this flag is true for a class, the class name cannot appear in AC, but its methods/variables can.
    super?: string[]; //for classes, the super classes' paths of that class.
    target?: string; //for objects that are referred without namespace: gets the full path
}

export interface LibraryPath {
    name: string;
    aliasFor: string;
}

export interface CursorPosition {
    top: number;
    left: number;
    height: number;
}

export const DefaultCursorPosition: CursorPosition = {
    top: 0,
    left: 0,
    height: 0,
};

export interface EditableSlotReachInfos {
    isKeyboard: boolean;
    direction: -1 | 1;
}

export interface StateAppObject {
    debugging: boolean;
    initialState: EditorFrameObjects;
    showKeystroke: boolean;
    nextAvailableId: number;
}

export interface StateAppObjects {
    [id: string]: StateAppObject;
}

export enum StrypePlatform {
    standard = "std",
    microbit = "mb",
}

export interface UserDefinedElement {
    name: string;
    isFunction: boolean;
}
export interface IndexedAcResult {
    index: number; 
    acResult: string; 
    documentation: string; 
    type: string;
    version: number;
}

export interface AcResultType {
    acResult: string; 
    documentation: string; 
    type: string;
    version: number;
}
export interface IndexedAcResultWithModule {
    [module: string]: IndexedAcResult[];
}
export interface AcResultsWithModule {
    [module: string]: AcResultType[];
}
export interface VoidFunction {
    (): void;
}

//Representation of an item of the (microbit) API using a coded identifier with its potential children
/* IFTRUE_isMicrobit */
export interface APICodedItem {
    name: string, //a UUID coded name that represent a single item of the API description (** do not use "." in the coded names, it messes i18n **)
    codePortion: string, //the code portion that will builds an example use in the editor (code builder)
    extraCodePortion?: string, //the optional full code portion to be shown in extra doc -- this code portion isn't used in the code builder
    version?: number, //the version of the API for this element (for instance 2 for microbit v2) if not provided, 1 is assumed
    children?: APICodedItem[];
}

//Representation of an item of the (microbit) API textual description based on a coded indentifier
export interface APIItemTextualDescription {
    name: string; //a UUID coded name that represent a single item of the API description
    label: string; //the textual value of the item
    doc: string; //the documentation for this item (short and always visible)
    extradoc: string; //the rest of the documentation for this item (visible on demand);
    codePortion: string, //the code portion that will builds an example use in the editor (code builder)
    extraCodePortion: string, //the full code portion to be shown in extra doc (or empty string if none) -- this code portion isn't used in the code builder
    version: number, //the version of the API for this element (for instance 2 for microbit v2)
    level: number; //the level of the item in the API hierarchy
    isFinal: boolean; //indicates if that is a termination item
    immediateParentName: string; //the name of the immediate parent of this item - empty string if level 1
}
/* FITRUE_isMicrobit */

//Object containing the different elements produced when parsing the code, to be used by parsing callers
export interface ParserElements {
    parsedOutput : string, //the python code generated by the parser
    hasErrors: boolean, //indicates the the code contains errors (precompiled & TigerPython errors)
    compiler: Compiler, //the compiler associated with this parser, that allow access to more complex objects generated after parsing code (i.e. blob, hex...)
}

// utility types
export interface CodeMatchIterable {
    hasMatches: boolean,
    iteratorMatches?: IterableIterator<RegExpMatchArray>
}
