import { getSHA1HashForObject } from "@/helpers/common";
import i18n from "@/i18n";
import { execPythonTestCode} from "@/helpers/execPythonCode";
import Parser from "@/parser/parser";
import { useStore } from "@/store/store";
import { AllFrameTypesIdentifier, BaseSlot, CaretPosition, CurrentFrame, EditorFrameObjects, FieldSlot, FlatSlotBase, FrameObject, getFrameDefType, isFieldBracketedSlot, isFieldStringSlot, isSlotBracketType, isSlotCodeType, NavigationPosition, PythonExecRunningState, SlotCoreInfos, SlotCursorInfos, SlotInfos, SlotsStructure, SlotType, StrypePlatform } from "@/types/types";
import Vue from "vue";
import { checkEditorCodeErrors, countEditorCodeErrors, getLabelSlotUID, getMatchingBracket, parseLabelSlotUID, hasPrecompiledCodeError } from "./editor";
import { nextTick } from "@vue/composition-api";

export const retrieveSlotFromSlotInfos = (slotCoreInfos: SlotCoreInfos): FieldSlot => {
    // Retrieve the slot from its id (used for UI), check generateFlatSlotBases() for IDs explanation    
    const rootSlotStruct = useStore().frameObjects[slotCoreInfos.frameId].labelSlotsDict[slotCoreInfos.labelSlotsIndex].slotStructures;
    const slotsLevelPos = slotCoreInfos.slotId.split(",");
    let currentSlotStruct = rootSlotStruct;
    const levelDepth = slotsLevelPos.length;
    slotsLevelPos.forEach((slotIndex, levelIndex) => {
        if(levelIndex < levelDepth - 1){
            // We are not yet in the terminal field/operator we are looking for, we update the structure variable
            currentSlotStruct = (currentSlotStruct.fields[parseInt(slotIndex)] as SlotsStructure);
        }                
    });

    return (slotCoreInfos.slotType == SlotType.operator) 
        ? currentSlotStruct.operators[parseInt(slotsLevelPos.at(-1) as string)] 
        : (currentSlotStruct.fields[parseInt(slotsLevelPos.at(-1) as string)]);
};

export const retrieveParentSlotFromSlotInfos = (slotInfos: SlotCoreInfos): FieldSlot | undefined => {
    // If the ID of the slot does not indicate any level, then there is no parent and we return undefined
    if(!slotInfos.slotId.includes(",")){
        return undefined;
    }

    const parentId = slotInfos.slotId.substring(0, slotInfos.slotId.lastIndexOf(","));
    //We find the slot. Since it cannot be an operator (an operator has no children) we set another type
    return retrieveSlotFromSlotInfos({...slotInfos, slotId: parentId, slotType: SlotType.code});
};

// This method generates the "flat" slot bases, which are used by the UI. It acts as a mapping between the data model saving slots as a tree, and a flat version that
// we feed Vue components to display the slots.
// The most important property here is the ID as it conveys the information about the slot's position in the tree structure of the data model, and is used by the UI
// to identify the slot (HTML-wise).
// The ids are in that format <x, y ... z> where each number is the position in the level (0-based index)
// The terminal level is indexed for either operator or field -- we know which one to check upon based on the slot type parameter
// for example if the root slot has only 3 same level children (field/operator/field), ids will respectively be "0", "0" and "1"
// if the root slot as 3 level children and the second of them has 3 same level children (again field/operator/field), ids will respectively be:
// "0", "1,0", "1,0", "1,1", "2"
export const generateFlatSlotBases = (slotStructure: SlotsStructure, parentId?: string, flatSlotConsumer?: (slot: FlatSlotBase) => void): FlatSlotBase[] => {
    // The operators always get in between the fields, and we always have one 1 root structure for a label,
    // and bracketed structures can never be found at 1st or last position
    let currIndex = -1;
    const flatSlotBases: FlatSlotBase[] = [];
    const addFlatSlot = (flatSlot: FlatSlotBase) => {
        flatSlotBases.push(flatSlot);
        // If a flat slot consumer is defined, we call it here
        if(flatSlotConsumer){
            flatSlotConsumer(flatSlot);
        }
    };

    slotStructure.operators.forEach((operatorSlot, index) => {
        // Add the precededing field
        currIndex++;
        const slotId = getSlotIdFromParentIdAndIndexSplit(parentId??"", currIndex);
        const fieldSlot = slotStructure.fields[index];
        if(isFieldBracketedSlot(fieldSlot)){
            // We have a bracketed structure, so we need to get into the nested level.
            // 1) add the opening bracket
            addFlatSlot({id: slotId, code: fieldSlot.openingBracketValue as string, type:SlotType.openingBracket});
            // 2) add what is inside the brackets
            flatSlotBases.push(...generateFlatSlotBases(fieldSlot as SlotsStructure, slotId, flatSlotConsumer));
            // 3) add the closing bracket
            addFlatSlot({id: slotId, code: getMatchingBracket(fieldSlot.openingBracketValue as string, true), type:SlotType.closingBracket});

        }
        else if(isFieldStringSlot(fieldSlot)){
            // We have a string slot
            // 1) add the opening quote
            addFlatSlot({id: slotId, code: fieldSlot.quote as string, type:SlotType.openingQuote});
            // 2) add what is inside the quotes
            addFlatSlot({id: slotId, code: fieldSlot.code, type:SlotType.string});
            // 3) add the closing quote
            addFlatSlot({id: slotId, code: fieldSlot.quote as string, type:SlotType.closingQuote});
        }
        else{
            // we have a simple slot, we check if we can infer the detailed type (i.e. number or boolean literals)
            // otherwise we consider it is just a code slot
            addFlatSlot({...(fieldSlot as BaseSlot), id: slotId, type: evaluateSlotType(fieldSlot)});
        }   

        // Add this operator only if it is not blank
        if(operatorSlot.code.length > 0) {
            addFlatSlot({...operatorSlot, id: slotId, type: SlotType.operator});
        }
    });

    // Add the last remaining field and call the consumer (if provided)
    currIndex++;
    addFlatSlot({...(slotStructure.fields.at(-1) as BaseSlot), id: getSlotIdFromParentIdAndIndexSplit(parentId??"", currIndex), type: evaluateSlotType(slotStructure.fields.at(-1) as FieldSlot)});

    return flatSlotBases;
};

export const retrieveSlotByPredicate = (frameLabelSlotStructs: SlotsStructure[], predicate: ((slot: FieldSlot) => boolean)): BaseSlot | undefined => {
    let resSlot: FieldSlot | undefined = undefined;

    for(const frameLabelSlotStruct of frameLabelSlotStructs){
        // Very unlikely we search something in operators, but better make the function complete
        resSlot = frameLabelSlotStruct.operators.find((operatorSlot) => predicate(operatorSlot));
    
        if(!resSlot){
            // Nothing found in operators, we check fields
            // As we look for slots, we need to get into the nested fields if needed
            for(const fieldSlot of frameLabelSlotStruct.fields){
                if(isFieldBracketedSlot(fieldSlot)){
                    resSlot = retrieveSlotByPredicate([fieldSlot as SlotsStructure], predicate);
                }
                else if(predicate(fieldSlot)){
                    resSlot = fieldSlot;
                }
                if(resSlot != null) {
                    break;
                }
            }
        }

        if(resSlot != null){
            break;
        }
    }

    return resSlot;
};
export const getSlotParentIdAndIndexSplit = (slotId: string): {parentId: string, slotIndex: number} => {
    const idMatchArray = slotId.match(/^((\d+,)*)(\d+)$/);
    if(idMatchArray){
        //Should match, keep TS happy
        return {
            parentId: (idMatchArray[1] != null) ? idMatchArray[1].substring(0,idMatchArray[1].length - 1) : "",
            slotIndex: parseInt(idMatchArray[3]),
        };
    }
    return  {parentId: "", slotIndex: -1};
};

export const getSlotIdFromParentIdAndIndexSplit = (parentId: string, slotIndex: number): string => {
    return (parentId + ((parentId.length > 0) ? "," : "") + slotIndex);
};

export const getFlatNeighbourFieldSlotInfos = (slotInfos: SlotCoreInfos, findNext: boolean, stopAtStructure?: boolean): SlotCoreInfos | null => {
    // Find the flat neighbour (i.e. sibling if in same level or neareast upper level slot) of the slot identified by slotId.
    // If findNext is true, we look for the next sibling, otherwise, we look for the previous.
    // Unless specified by the optional flag stopAtStructure is true, we search for field slots, so operators are ignored.
    const parentIdAndIndexSplit = getSlotParentIdAndIndexSplit(slotInfos.slotId);
    const parentId = parentIdAndIndexSplit.parentId;
    const hasParent = (parentId.length > 0);
    const slotIndex = parentIdAndIndexSplit.slotIndex;
    const sameLevelSlotsCount = hasParent 
        ? (retrieveSlotFromSlotInfos({...slotInfos, slotId: parentId}) as SlotsStructure).fields.length // a parent is by definition a SlotStructure
        : useStore().frameObjects[slotInfos.frameId].labelSlotsDict[slotInfos.labelSlotsIndex].slotStructures.fields.length;
    const isNeighbourInSameLevel = findNext ? (slotIndex < sameLevelSlotsCount - 1) : (slotIndex > 0);
    if(isNeighbourInSameLevel){
        // The flat neighbour is a sibling of that node, that's easy we just return that sibling
        const neighbourSlotId = getSlotIdFromParentIdAndIndexSplit(parentId, slotIndex + (findNext ? 1 : -1));
        const neighbourSlot = retrieveSlotFromSlotInfos({...slotInfos, slotId: neighbourSlotId}); 
        const type = evaluateSlotType(neighbourSlot);
        if(isSlotBracketType(type) && !stopAtStructure){
            // Get the field inside the bracket: first child field if looking for next neighbour, last otherwise.
            const childFieldId = (findNext) ? 0 : (neighbourSlot as SlotsStructure).fields.length - 1;
            const noTypeChildSlotInfos = {...slotInfos, slotId: neighbourSlotId + "," + childFieldId};
            const childType = evaluateSlotType(retrieveSlotFromSlotInfos(noTypeChildSlotInfos));
            return {...noTypeChildSlotInfos, slotType: childType};
        }
        return {...slotInfos, slotId: neighbourSlotId, slotType: type};
    }
    else{
        // The flat neighbour is not a sibling of that node, so we look for the parent's sibling instead
        // (which will return undefined if not found)
        return hasParent ? getFlatNeighbourFieldSlotInfos({...slotInfos, slotId: parentId}, findNext, stopAtStructure) : null;
    }
};

export function isFrameLabelSlotStructWithCodeContent(slotsStruct: SlotsStructure): boolean {
    let hasContent = false;
    for(const fieldSlot of slotsStruct.fields){
        if(isFieldBracketedSlot(fieldSlot)){
            hasContent ||= isFrameLabelSlotStructWithCodeContent((fieldSlot as SlotsStructure));
        }
        else {
            hasContent ||=  fieldSlot.code.trim().length > 0;
        }
        if(hasContent) {
            break;
        }
    }
    return hasContent;
}

export const evaluateSlotType = (slot: FieldSlot): SlotType => {
    if(isFieldBracketedSlot(slot)){
        return SlotType.bracket;
    }
    else if (isFieldStringSlot(slot)){
        return  SlotType.string;
    }
    else {
        // Other things are just "code"
        return SlotType.code;
    }
};

export const removeFrameInFrameList = (frameId: number): void => {
    // When removing a frame in the list, we remove all its sub levels,
    // then update its parent and then delete the frame itself
    const frameObject = useStore().frameObjects[frameId];

    //we need a copy of the childrenIds are we are modifying them in the foreach
    const childrenIds = [...frameObject.childrenIds];
    childrenIds.forEach((childId: number) => removeFrameInFrameList(childId));
    //we need a copy of the jointFrameIds are we are modifying them in the foreach
    const jointFramesIds = [...frameObject.jointFrameIds];
    jointFramesIds.forEach((jointFrameId: number) => removeFrameInFrameList(jointFrameId));
    const deleteAJointFrame = (frameObject.jointParentId > 0); 
    const listToUpdate = (deleteAJointFrame) ? useStore().frameObjects[frameObject.jointParentId].jointFrameIds : useStore().frameObjects[frameObject.parentId].childrenIds;
    listToUpdate.splice(
        listToUpdate.indexOf(frameId),
        1
    );

    //Now we can delete the frame from the list of frameObjects
    Vue.delete(
        useStore().frameObjects,
        frameId
    );
};

// Returns the parentId of the frame or if it is a joint frame returns the parentId of the JointParent.
export const getParent = (currentFrame: FrameObject): number => {
    let parentId = 0;
    if(currentFrame.id !== 0){
        parentId = (currentFrame.jointParentId > 0) ? useStore().frameObjects[currentFrame.jointParentId].parentId : currentFrame.parentId;
    }
    return parentId;
};

// Returns the frame container id of a given frame (which is a valid frame, not a container itself)
export const getFrameContainer = (frameId: number): number => {
    const parentFrameId = getParentOrJointParent(frameId);
    if(parentFrameId > 0){
        return getFrameContainer(parentFrameId);
    }
    else{
        return parentFrameId;
    }
};

export const getFrameSectionIdFromFrameId = (frameId: number): number => {
    // Retrieve the id of the frame section (imports, function definitions or main code) of frame given its id.   
    // (We know when we reached a frame section when the id of that frame is negative; all frame sections are defined with a negative index.) 
    let parentId = frameId;
    while(parentId > 0){
        parentId = getParent(useStore().frameObjects[parentId]);
    }    
    return parentId;
};

// Checks if it is a joint Frame or not and returns JointParent OR Parent respectively
export const getParentOrJointParent = (frameId: number): number  => {
    const isJointFrame = useStore().frameObjects[frameId].frameType.isJointFrame;
    return (isJointFrame)? 
        useStore().frameObjects[frameId].jointParentId:
        useStore().frameObjects[frameId].parentId;
};

export const isLastInParent = (frameId: number): boolean => {
    const frame = useStore().frameObjects[frameId];
    const parent = useStore().frameObjects[getParentOrJointParent(frameId)];

    const siblingList = (frame.jointParentId>0)? parent.jointFrameIds : parent.childrenIds;

    return (siblingList.indexOf(frameId) === siblingList.length-1);
};

//Returns a list with all the previous frames (of the same level) and next frames (including first level children) used for navigating the caret
export const childrenListWithJointFrames = (currentFrameId: number, caretPosition: CaretPosition, direction: "up"|"down"): number[] => {
    const currentFrame = useStore().frameObjects[currentFrameId];
            
    // Create the list of children + joints with which the caret will work with
    let childrenAndJointFramesIds = [] as number[];
    const parentId = getParent(currentFrame);

    childrenAndJointFramesIds = [...useStore().frameObjects[parentId].childrenIds];    
    
    // Joint frames are added to a temp list and caret works with this list instead.
    if (isFramePartOfJointStructure(currentFrame.id)) {

        const jointParentId = (currentFrame.jointParentId > 0) ? currentFrame.jointParentId : currentFrame.id;
        const indexOfJointParent = childrenAndJointFramesIds.indexOf(jointParentId);

        //the joint frames are added to the temporary list
        childrenAndJointFramesIds.splice(
            indexOfJointParent+1,
            0,
            ...useStore().frameObjects[jointParentId].jointFrameIds
        );
    }
    
    if (direction === "up") {
        // when going up and, if the previous frame is part of a compound or another container we need to add it in the list
        const indexOfCurrentInParent = childrenAndJointFramesIds.indexOf(currentFrame.id);
        const previousId = childrenAndJointFramesIds[indexOfCurrentInParent - 1];

        // If the previous is simply my parent, there is not need to check whether he has JointChildren as even if he has
        // I am already above them (in his body). (if the prevID is undefined, that means I am the first child)
        if(previousId !== undefined && previousId !== currentFrame.parentId){

            //get the previous container's children if the current frame is a container (OR keep self it first container),
            //otherwise, get the previous frame's joint frames
            const previousSubLevelFrameIds = 
                (currentFrame.id < 0) ?
                    ((indexOfCurrentInParent > 0) ? 
                        useStore().frameObjects[previousId].childrenIds : 
                        []
                    ) :
                    useStore().frameObjects[previousId].jointFrameIds;
           
            //the last joint frames are added to the temporary list
            childrenAndJointFramesIds.splice(
                indexOfCurrentInParent,
                0,
                ...previousSubLevelFrameIds  
            );

        }
    }
    else {
        if(caretPosition === CaretPosition.body){
            // add its children to the list
            childrenAndJointFramesIds.splice(
                childrenAndJointFramesIds.indexOf(currentFrame.id)+1,
                0,
                ...currentFrame.childrenIds
            );
        }
    }
    
    return childrenAndJointFramesIds;
};

export const countRecursiveChildren = function(frameId: number, countLimit?: number): number {
    // This method counts all recursive children (i.e. children, grand children, ...) of a frame.
    // The countLimit is a threshold to reach where we can stop recursion. Therefore the number of children returned IS NOT guaranted
    // to be less than the limit: it just means we don't look at any more siblings/sub children if we reached this limit.
    // If this argument isn't passed in the method, all recursive children are counted until we reach the end of the tree.
    
    const currentChildrenIds = useStore().frameObjects[frameId].childrenIds;
    const currentJointFramesIds = useStore().frameObjects[frameId].jointFrameIds;
    
    let childrenCount = currentChildrenIds.length;
    if(countLimit === undefined || childrenCount < countLimit){
        //if there is no limit set, or if we haven't reached it, we look at the subchildren
        currentChildrenIds.forEach((childId: number) => childrenCount += countRecursiveChildren(
            childId, 
            countLimit
        ));
        //if there is no limit set, or if we haven't reached it, we look at the children of the joint frames
        if(countLimit === undefined || childrenCount < countLimit){
            //for the joint frame structure, if a joint frame has at least one child, we count is as its parent 
            //child to give it a count.
            currentJointFramesIds.forEach((jointFrameId: number) => {
                if(useStore().frameObjects[jointFrameId].childrenIds.length > 0){
                    childrenCount++;
                }
                childrenCount += countRecursiveChildren(
                    jointFrameId, 
                    countLimit
                );
            });
        }
    }

    return childrenCount;
};

export const cloneFrameAndChildren = function(listOfFrames: EditorFrameObjects, currentFrameId: number, parentId: number,  nextAvailableId: { id: number}, framesToReturn: EditorFrameObjects): void {
    // This method recursively clones a frame and all its children.
    // `nextAvailableId` is used to store the id that each cloned frame will take. It is an Object in order to
    // enable Pass-By-Reference whenever it is increased.
    
    // first copy the current frame
    // You can also use Lodash's "_.cloneDeep" in case JSON.parse(JSON.stringify()) has a problem on Mac
    const frame: FrameObject = JSON.parse(JSON.stringify(listOfFrames[currentFrameId])) as FrameObject;

    frame.id = nextAvailableId.id;
    frame.caretVisibility = CaretPosition.none;

    // Change the parent as well to the frame who called this instance of the method.
    if (frame.parentId !== 0) {
        frame.parentId = parentId;
    }
    else {
        frame.jointParentId  = parentId;
    }
    
    // Add the new frame to the list
    framesToReturn[frame.id] = frame;

    //Look at the subChildren first and then at the joint frames
    frame.childrenIds.forEach((childId: number, index: number) => {
        frame.childrenIds[index] = ++nextAvailableId.id;
        cloneFrameAndChildren(
            listOfFrames,
            childId,
            frame.id,
            nextAvailableId, 
            framesToReturn
        );
    });

    //Look at the subChildren first and then at the joint frames
    frame.jointFrameIds.forEach((childId: number, index: number) => {
        frame.jointFrameIds[index] = ++nextAvailableId.id;
        cloneFrameAndChildren(
            listOfFrames,
            childId,
            frame.id,
            nextAvailableId,
            framesToReturn
        );
    });
    
};

//Search all children/joint frames ids for a specific frame
export const getAllChildrenAndJointFramesIds = function(frameId: number): number[]  {
    const childrenJointsIdsList = [] as number[];

    //get the children frames ids
    useStore().frameObjects[frameId].childrenIds.forEach((childId: number) => {
        childrenJointsIdsList.push(childId);
        childrenJointsIdsList.push(...getAllChildrenAndJointFramesIds(childId));
    });

    //get the joint frames ids
    useStore().frameObjects[frameId].jointFrameIds.forEach((jointId: number) => {
        childrenJointsIdsList.push(jointId);
        childrenJointsIdsList.push(...getAllChildrenAndJointFramesIds(jointId));
    });

    return childrenJointsIdsList;
};

export const checkStateDataIntegrity = function(obj: {[id: string]: any}): boolean {
    //check the checksum and version properties are present and checksum is as expected, if not, the document doesn't have integrity
    if(obj["checksum"] === undefined || obj["version"] === undefined){
        return false;
    }
    else{
        //take the checkpoints out the object to check the checksum
        const foundChecksum = obj["checksum"];
        delete obj["checksum"];
        const foundVersion = obj["version"];
        delete obj["version"];
        let foundPlatform = undefined;
        if(obj["platform"]){
            foundPlatform = obj["platform"];
            delete obj["platform"];
        }
        //get the checksum from the object
        const expectedChecksum = getSHA1HashForObject(obj);
        //add the read version and platform as they are needed later
        obj["version"] = foundVersion;
        obj["platform"] = foundPlatform ?? StrypePlatform.standard;
        //and return if the checksum was right
        return foundChecksum === expectedChecksum;        
    }
};

export const restoreSavedStateFrameTypes = function(state:{[id: string]: any}): boolean {
    if(state["frameObjects"] == undefined){
        return false;
    }
    
    let success = true;
    const frameIds: string[] = Object.keys(state["frameObjects"]);
    // We iterate through all the given frame type names to find the matching object. If at one iteration we cannot find the corresponding object
    // (a case where we make a mistake in the code and change the frame type name recklessly !) then we don't need to continue iterating the given
    // state frame names. The forEach() methohd won't allow us to break, so we use every() which retunrs false if the loop shall be broken.
    frameIds.every((frameId) => {
        const frameTypeValue = (state["frameObjects"][frameId].frameType);
        if(typeof frameTypeValue === "string") {
            // The frame type in the state was saved by the type name (string): we get the equivalent frame type object
            // in the unlikely event we can't find the object we stop the restoration and notify failure
            const correspondingFrameObj = getFrameDefType(frameTypeValue);
            if(correspondingFrameObj  !== undefined) {
                state["frameObjects"][frameId].frameType = correspondingFrameObj;
                return true;
            }
            success = false;
            return false;
        }
    });

    // If we have managed to load the state, then we might need to make sure the caret is in view
    if(success){
        setTimeout(() => {
            const htmlElementToShowId = (useStore().focusSlotCursorInfos) ? getLabelSlotUID((useStore().focusSlotCursorInfos as SlotCursorInfos).slotInfos) : ("caret_"+useStore().currentFrame.caretPosition+"_of_frame_"+useStore().currentFrame.id);
            document.getElementById(htmlElementToShowId)?.scrollIntoView();
        }, 1000);
    }   
    return success;
};

// Finds out what is the root frame Id of a "block" of disabled frames
export const getDisabledBlockRootFrameId = function(frameId: number): number {
    const frameParentId = (useStore().frameObjects[frameId].jointParentId > 0) ? useStore().frameObjects[frameId].jointParentId : useStore().frameObjects[frameId].parentId;
    if(useStore().frameObjects[frameParentId].isDisabled){
        return getDisabledBlockRootFrameId(frameParentId);
    }
    else{
        return frameId;
    }
};

export const getLastSibling= function (frameId: number): number {
    
    const isJointFrame = useStore().frameObjects[frameId].frameType.isJointFrame;
    const parentId = (isJointFrame) ? useStore().frameObjects[frameId].jointParentId : useStore().frameObjects[frameId].parentId;
    const parentsChildren = (isJointFrame) ? useStore().frameObjects[parentId].jointFrameIds : useStore().frameObjects[parentId].childrenIds;

    return parentsChildren[parentsChildren.length-1];
    
};

export const getAllSiblings= function (frameId: number): number[] {
    const isJointFrame = useStore().frameObjects[frameId].frameType.isJointFrame;
    const parentId = (isJointFrame) ? useStore().frameObjects[frameId].jointParentId : useStore().frameObjects[frameId].parentId;

    return (isJointFrame) ? useStore().frameObjects[parentId].jointFrameIds : useStore().frameObjects[parentId].childrenIds;    
};

export const getNextSibling= function (frameId: number): number {
    const isJointFrame = useStore().frameObjects[frameId].frameType.isJointFrame;
    const parentId = (isJointFrame) ? useStore().frameObjects[frameId].jointParentId : useStore().frameObjects[frameId].parentId;

    const list = (isJointFrame) ? useStore().frameObjects[parentId].jointFrameIds : useStore().frameObjects[parentId].childrenIds;    

    return list[list.indexOf(frameId)+1]??-100;
};

export const getAllSiblingsAndJointParent= function (frameId: number): number[] {
    const isJointFrame = useStore().frameObjects[frameId].frameType.isJointFrame;
    const parentId = (isJointFrame) ? useStore().frameObjects[frameId].jointParentId : useStore().frameObjects[frameId].parentId;

    return (isJointFrame)? [useStore().frameObjects[frameId].jointParentId, ...useStore().frameObjects[parentId].jointFrameIds] : useStore().frameObjects[parentId].childrenIds;    
};

export const frameForSelection = (currentFrame: CurrentFrame, direction: "up"|"down", selectedFrames: number[]): {frameForSelection: number, newCurrentFrame: CurrentFrame}|null => {
    
    // we first check the cases that are 100% sure there is nothing to do about them
    // i.e.  we are in the body and we are either moving up or there are no children.
    if( currentFrame.caretPosition === CaretPosition.body && (direction === "up" || useStore().frameObjects[currentFrame.id].childrenIds.length === 0) ){
        return null;
    }

    const parentId = (currentFrame.caretPosition === CaretPosition.body)? 
        currentFrame.id : 
        getParentOrJointParent(currentFrame.id);

    const parent = useStore().frameObjects[parentId];
    const isCurrentJoint = useStore().frameObjects[currentFrame.id].jointParentId > 0;

    // If there are no joint frames in the parent, even if we are talking about a frame that can have joint frames (i.e. a single if),
    // then the list is the same level children.
    // The complex occasion is the last jointFrame where we need to get the children of its parent's parent...
    // Even more complex is the occasion that the last jointFrame is already selected, hence we need to de-select it, hence return it.
    let actualCurrentFrameId = currentFrame.id;
    let sameLevelFrameIds = parent.childrenIds;
    if (isCurrentJoint && parent.jointFrameIds.length > 0) {
        if(isLastInParent(currentFrame.id) && !selectedFrames.includes(currentFrame.id)) {
            sameLevelFrameIds = useStore().frameObjects[parent.parentId].childrenIds;
            actualCurrentFrameId = parent.id;
        }
        else {
            sameLevelFrameIds = parent.jointFrameIds;
        }
    }
    // In the case that we are below a parent of joint frames the list is the joint children
    else if(currentFrame.caretPosition === CaretPosition.below && direction !== "up" && useStore().frameObjects[currentFrame.id].jointFrameIds.length >0) {
        sameLevelFrameIds = useStore().frameObjects[currentFrame.id].jointFrameIds;
    }

    const indexDelta = (direction === "up")? -1 : 1;

    // If the caret is in the body position the index is 0; 
    // Being below and going up it's just the index of the actualCurrentFrameId
    // Being below and going down we need to get the next
    // ((indexDelta+1)&&1) returns +1 only if we are going down (indexDelta==1)
    const indexOfCurrentInParent = (currentFrame.caretPosition === CaretPosition.body)? 0: sameLevelFrameIds.indexOf(actualCurrentFrameId)+Math.max(indexDelta, 0);

    // frameToBeSelected is the frame that will be selected AND can be different than the current frame (e.g. caret==below and direction down). 
    // We select a frame other than the current frame if we are moving down and we are not on position 0;
    // Only for caret==body or when going UP, we select this frame.
    const frameToBeSelected = sameLevelFrameIds[indexOfCurrentInParent];


    // If we are about to select non Joint frame and in the current selection there are Joint frames then we prevent it
    const hasJointChildren = selectedFrames.find((id) => useStore().frameObjects[id].jointParentId > 0) ?? 0;
    if( hasJointChildren > 0 && useStore().frameObjects[frameToBeSelected].jointParentId === 0) {
        return null;
    }

    // Create the list of children + joints with which the caret will work with
    const allSameLevelFramesAndJointIds = 
    childrenListWithJointFrames(
        frameToBeSelected,
        currentFrame.caretPosition, 
        direction
    );

    // If what we're trying to access doesn't exist return null
    if( frameToBeSelected !== undefined ) {
        let indexOfSelectedInWiderList = allSameLevelFramesAndJointIds.indexOf(frameToBeSelected);

        const numberOfJointChildrenOfSelected = useStore().frameObjects[frameToBeSelected].jointFrameIds.length;

        if( numberOfJointChildrenOfSelected > 0 && direction === "down") {
            // indexDelta gives us the + or - for the direction of how many jointChildren we need to skip.
            indexOfSelectedInWiderList += (indexDelta * numberOfJointChildrenOfSelected);
        }
        else if (direction === "up") {
            indexOfSelectedInWiderList += indexDelta;
        }

        const indexOfNewCaret = 
            ((indexOfSelectedInWiderList === allSameLevelFramesAndJointIds.length-1)? 
                allSameLevelFramesAndJointIds.length-1 : 
                indexOfSelectedInWiderList );

        const newCurrentFrame = (indexOfNewCaret === -1)? 
            {id: parent.id , caretPosition: CaretPosition.body} :
            {id: allSameLevelFramesAndJointIds[indexOfNewCaret], caretPosition: CaretPosition.below};
        
        return {frameForSelection: frameToBeSelected, newCurrentFrame: newCurrentFrame};

    }
    else {
        return null;
    }
    
};

export const checkIfLastJointChild = function (frameId: number): boolean {
    const parent: FrameObject = useStore().frameObjects[useStore().frameObjects[frameId].jointParentId];
    return [...parent.jointFrameIds].pop() === frameId;
};

export const isFramePartOfJointStructure = function (frameId: number): boolean {
    const frame = useStore().frameObjects[frameId];
    return (frame.frameType.isJointFrame || frame.jointFrameIds.length > 0);
};


export const checkIfFirstChild = function (frameId: number): boolean {
    const parent: FrameObject = useStore().frameObjects[useStore().frameObjects[frameId].parentId||useStore().frameObjects[frameId].jointParentId];
    return ([...parent.childrenIds].shift()??[...parent.jointFrameIds].shift()) === frameId;
};

// This method checks if there is a compound (parent+child) frame above the selected frame and returns the 
// the correct previous e.g. if(1): "2" elif(3): "4"  and we are after "4" and going up, we should end up below "3" and not "4"!
export const getPreviousIdForCaretBelow = function (currentFrame: number): number {

    // selecting means selecting a same level frame 
    const siblings = getAllSiblings(currentFrame);

    // if there is a previous sibling then get it, otherwise get the parent
    const previous = siblings[siblings.indexOf(currentFrame)-1]??useStore().frameObjects[currentFrame].parentId;

    // in case the sibling has joint children, going up means going under it's last child
    return [...useStore().frameObjects[previous].jointFrameIds].pop()??previous;
    
};

// This method checks the available positions for a caret (i.e. no positions for editable slots) and find what
// position of a caret would be "above" a frame. For example, if the given frame is the first child of a if frame
// the position return is the body of the containing if frame.
export const getAboveFrameCaretPosition = function (frameId: number): NavigationPosition {
    // step 1 --> get all the caret position (meaning all navigation positions minus the editable slot ones)   
    const availablePositions = getAvailableNavigationPositions().filter((navigationPosition) => !navigationPosition.isSlotNavigationPosition);
   
    // step 2 --> find the index of the dragged top frame caret based on this logic:
    // if we had moved an block frame, we look for the caret position before the that block frame "body" position (which is the first position for that block frames)
    // if we had moved a statement frame, we look for the caret position before the statement frame "below" position (which is the first position for that statemen frame)
    const referenceFramePosIndex = availablePositions.findIndex((navPos) => navPos.frameId == frameId
        && navPos.caretPosition == ((useStore().frameObjects[frameId].frameType.allowChildren) ? CaretPosition.body : CaretPosition.below));
    
    // step 3 --> get the position before that (a frame is at least contained in a frame container, so position index can't be 0)
    const prevCaretPos = availablePositions[referenceFramePosIndex - 1];
    
    // step 4 --> return the position
    return prevCaretPos;
};

// This method returns a boolean value indicating whether the caret (current position) is contained
// within one of the frame types specified in "containerTypes"
export const isContainedInFrame = function (currFrameId: number, caretPosition: CaretPosition, containerTypes: string[]): boolean {
    let isAncestorTypeFound = false;
    let frameToCheckId = (caretPosition === CaretPosition.body) ? 
        currFrameId:
        getParent(useStore().frameObjects[currFrameId]);
    
    while(frameToCheckId != 0 && !isAncestorTypeFound){
        isAncestorTypeFound = containerTypes.includes(useStore().frameObjects[frameToCheckId].frameType.type);
        frameToCheckId = getParent(useStore().frameObjects[frameToCheckId]);
    }

    return isAncestorTypeFound;
};

// This method returns a boolean value indicating whether the frame is contained
// within one of the frame types specified in "containerTypes"
export const isContainedInFrameType = function (currFrameId: number, containerTypes: string[]): boolean {
    let isAncestorTypeFound = false;
    let frameToCheckId = getParent(useStore().frameObjects[currFrameId]);
    
    while(frameToCheckId != 0 && !isAncestorTypeFound){
        isAncestorTypeFound = containerTypes.includes(useStore().frameObjects[frameToCheckId].frameType.type);
        frameToCheckId = getParent(useStore().frameObjects[frameToCheckId]);
    }

    return isAncestorTypeFound;
};

// Instead of calculating the available caret positions through the store (where the frameObjects object is hard to use for this)
// We get the available caret positions through the DOM, where they are all present.
export const getAvailableNavigationPositions = function(): NavigationPosition[] {
    // We start by getting from the DOM all the available caret and editable slot positions 
    // (slots of "code" type slots, e.g. not operators -- won't appear in allCaretDOMPositions)
    const allCaretDOMpositions = document.getElementsByClassName("navigationPosition");
    // We create a list that hold objects of {frameId,isSlotNavigationPosition,caretPosition?,labelSlotsIndex?, slotId?) for each available navigation positions
    // and discard the locations that correspond to the editable slots of disable frames
    return Object.values(allCaretDOMpositions).map((e)=> {
        const isSlotNavigationPosition = e.id.startsWith("input");
        // Retrieves the identifier for the navigation position: the type of caret position for a caret (e.g. "caretBody"), the indexes/ids for a slot
        // we extract it from the id of the elements, they are of that form:
        // slots (*) --> "input_frame_<frameId>_label_<labelSlotsIndex>_slot_<slotType>_<slotId>" where <frameId>, <labelSlotsIndex> and <slotType> are numbers and <slotId> a string (we want <slotIndex> and <slotId>)
        // carets --> "caret_<type>_<frameId>" where <type> is one of caretBelow or caretBody, and <frameId> as mentioned above (we want <type>)
        // (*) cf function getLabelSlotUID in the helper editor.ts
        const labelSlotCoreInfos = parseLabelSlotUID(e.id);
        const positionObjIdentifier = (isSlotNavigationPosition) 
            ? {labelSlotsIndex: labelSlotCoreInfos.labelSlotsIndex, slotId: labelSlotCoreInfos.slotId, slotType: labelSlotCoreInfos.slotType}
            : {caretPosition: e.id.includes(CaretPosition.below) ? CaretPosition.below : CaretPosition.body}; 
        // We retrieve also the frameId from the identifier of the element (format is mentioned above)
        const frameIdMatch = e.id.match(/-?\d+/);
        return {
            frameId: (frameIdMatch != null) ? parseInt(frameIdMatch[0]) : -100, // need to check the match isn't null for TS, but it should NOT be.
            isSlotNavigationPosition: isSlotNavigationPosition, 
            ...positionObjIdentifier,            
        };
    }).filter((navigationPosition) => useStore().frameObjects[navigationPosition.frameId] && !(navigationPosition.isSlotNavigationPosition && useStore().frameObjects[navigationPosition.frameId].isDisabled)) as NavigationPosition[]; 
};

export const checkPrecompiledErrorsForSlot = (slotInfos: SlotInfos): void => {
    // This method for checking errors is called when a frame has been edited (and lost focus), or during undo/redo changes. As we don't have a way to
    // find which errors are from TigerPython or precompiled errors, and that we wouldn't know what specific error to remove anyway,
    // we clear the errors completely for that frame/slot before we check the errors again for it.
    const slot = retrieveSlotFromSlotInfos(slotInfos);
    const currentErrorMessage = (slot as BaseSlot).error;
    useStore().setSlotErroneous(
        {
            ...slotInfos,
            error: "",
        }
    );
    Vue.delete(slot,"errorTitle");

    /* IFTRUE_isPurePython */
    // If the frame of this slot has a runtime error, we also clear it
    Vue.delete(useStore().frameObjects[slotInfos.frameId], "runTimeError");
    /* FITRUE_isPurePython */

    // Check for precompiled errors (empty slots)
    const frameObject = useStore().frameObjects[slotInfos.frameId];
    // Optional slot is relevant to a label, therefore, we consider it is actually relevant only if 1 field slost is in the structure
    // or if we are in the specific case of a function call label that has empty "function name" slot (and brackets)
    function notEmptyFunctionNameInFunctionCallFrame(): boolean {
        // This test is in a function only to make the returned value condition "lighter" than if we had a variable (the function is called only when needed)
        return (useStore().frameObjects[slotInfos.frameId].frameType.type != AllFrameTypesIdentifier.funccall
            || !isFieldBracketedSlot(useStore().frameObjects[slotInfos.frameId].labelSlotsDict[0].slotStructures.fields[1])
            || slotInfos.slotId != "0");
    }
    const isOptionalSlot = (frameObject.labelSlotsDict[slotInfos.labelSlotsIndex].slotStructures.fields.length > 1 && notEmptyFunctionNameInFunctionCallFrame()) 
        || (frameObject.frameType.labels[slotInfos.labelSlotsIndex].optionalSlot ?? false);
    if(slotInfos.code !== "") {
        //if the user entered text in a slot that was blank before the change, remove the error
        if(currentErrorMessage === i18n.t("errorMessage.emptyEditableSlot")) {
            useStore().removePreCompileErrors(getLabelSlotUID(slotInfos));                
        }
    }
    else if(!isOptionalSlot){
        useStore().setSlotErroneous( 
            {
                ...slotInfos,  
                error: i18n.t("errorMessage.emptyEditableSlot") as string,
            }
        );
        useStore().addPreCompileErrors(getLabelSlotUID(slotInfos));
    }
};

export function checkPrecompiledErrorsForFrame(frameId: number): void {
    // We wil need to recreate the slot ID while parsing each slots of the frame to check errors on them
    // so we use the FlatSlotBase generator (only on that frame), and apply the error checks for each flat slot
    // ONLY on code type slots
    const frameObject = useStore().frameObjects[frameId];
    Object.values(frameObject.labelSlotsDict).forEach((labelSlotStruct, labelSlotsIndex) => {
        generateFlatSlotBases(labelSlotStruct.slotStructures, "", (flatSlot: FlatSlotBase) => {
            if(isSlotCodeType(flatSlot.type)){
                const slotInfos = {
                    frameId: frameId,
                    labelSlotsIndex: labelSlotsIndex,
                    slotId: flatSlot.id,
                    slotType: flatSlot.type,
                    code: flatSlot.code,
                    error: flatSlot.error,
                    errorTitle: flatSlot.errorTitle,
                    // These other properties are not important
                    initCode: "",
                    isFirstChange: true,
                };
                if (frameObject.isDisabled) {
                    // If frame is disabled, just clear the error and don't do any checks:
                    useStore().setSlotErroneous(
                        {
                            ...slotInfos,
                            error: "",
                        }
                    );
                }
                else {
                    // If the frame is enabled, actually check for errors:
                    checkPrecompiledErrorsForSlot(slotInfos);
                }
            }
        });
    });
}

export function checkCodeErrors(frameIdForPrecompiled?: number): void {
    // Clear all errors first.
    // We do this in two pass: 
    //   1) check for the UI pre-compiled errors for each frame unless if a specific frame is specified, then we check that frame only
    const frameArray = ((frameIdForPrecompiled) ? [frameIdForPrecompiled.toString()] : Object.keys(useStore().frameObjects));
    for(const frameId of frameArray){
        checkPrecompiledErrorsForFrame(parseInt(frameId));
    } 
    //  2) check for TP errors for the whole code
    // We don't want to crash the application if something isn't handled correctly in TP.
    // So in case of an error, we catch it to allow the rest of the code to execute...
    try{
        const parser = new Parser(true);
        parser.getErrorsFormatted(parser.parse());
    }
    catch(error){
        console.log(error);
    }
    // We make sure the number of errors shown in the interface is in line with the current state of the code
    // As the UI should update first, we do it in the next tick
    nextTick().then(() => {
        checkEditorCodeErrors();
        useStore().errorCount = countEditorCodeErrors();
        useStore().lastEditTime = Date.now();
    }); 
}

export function runTests(forceRun: boolean): void{

    setTimeout(() => {

        if ((Date.now() - useStore().lastEditTime < useStore().testExecutionInterval && useStore().pythonExecRunningState == PythonExecRunningState.NotRunning)
        || forceRun){
        
            const parser = new Parser();
            const userCode = parser.getFullTestCode();

            if(hasPrecompiledCodeError()) {
                console.log("fail");
                Object.keys(useStore().failedTests).forEach((key) => {
                    useStore().failedTests[key] = "Test bruv";
                });
                return;
            }
            if (useStore().isEditing){
                return;
            }

            // Trigger the actual Python code execution launch
            nextTick().then(() => {
                console.log(userCode);
                execPythonTestCode(userCode, parser.getFramePositionMap());
            });
        }

    }, 1000);
}

export function getAllEnabledUserDefinedFunctions() : FrameObject[] {
    return Object.values(useStore().frameObjects).filter((f) => f.frameType.type === AllFrameTypesIdentifier.funcdef && !f.isDisabled && (f.labelSlotsDict[0].slotStructures.fields[0] as BaseSlot).code.length > 0);
}
