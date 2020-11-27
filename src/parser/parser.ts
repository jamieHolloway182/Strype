import store from "@/store/store";
import { FrameContainersDefinitions, FrameObject, LineAndSlotPositions } from "@/types/types";
import { ErrorInfo, TPyParser } from "tigerpython-parser";

const INDENT = "    ";

const DISABLEDFRAMES_FLAG =  "\"\"\"";
let isDisabledFramesTriggered = false; //this flag is used to notify when we enter and leave the disabled frames.
let disabledBlockIndent = "";

export default class Parser {

    private framePositionMap: LineAndSlotPositions = {} as LineAndSlotPositions;  // For each line holds the positions the slots start at
    private line = 0;

    private parseBlock(block: FrameObject, indent: string): string {
        let output = "";
        const children = store.getters.getFramesForParentId(block.id);

        output += 
            this.parseStatement(block,indent) + 
            ((block.frameType.allowChildren && children.length > 0)?
                this.parseFrames(
                    store.getters.getFramesForParentId(block.id),
                    indent + INDENT
                ) :
                "") // empty bodies are added as empty lines in the code
            + 
            this.parseFrames(
                store.getters.getJointFramesForFrameId(block.id, "all"), 
                indent
            );
        
        return output;
    }
    
    private parseStatement(statement: FrameObject, indent = ""): string {
        let output = indent;
        const positions: number[] = [];
        const lengths: number[] = [];
        let currSlotIndex = 0;
            
        statement.frameType.labels.forEach( (label) => {
            if(!label.slot || statement.contentDict[currSlotIndex].shownLabel) {
                output += label.label;

                //if there is an editable slot
                if(label.slot){
                    // Record its vertical position
                    const currentPosition = output.length;
                    positions.push(currentPosition);
                    // add its code to the output
                    output += statement.contentDict[currSlotIndex].code + " ";
                    lengths.push(output.length-currentPosition+1);
                }
            }
            currSlotIndex++;
        });
        
        output += "\n";
    
        this.framePositionMap[this.line] =  {frameId: statement.id, slotStarts: positions, slotLength: lengths};
        
        this.line += 1;

        return output;
    }

    private parseFrames(codeUnits: FrameObject[], indent = ""): string {
        let output = "";
        let lineCode = "";

        //if the current frame is a container, we don't parse it as such
        //but parse directly its children (frames that it contains)
        for (const frame of codeUnits) {
            //if the frame is disabled and we were not in a disabled group of frames, add the comments flag
            let disabledFrameBlockFlag = "";
            if(frame.isDisabled ? !isDisabledFramesTriggered : isDisabledFramesTriggered) {
                isDisabledFramesTriggered = !isDisabledFramesTriggered;
                if(frame.isDisabled) {
                    disabledBlockIndent = indent;
                }
                disabledFrameBlockFlag = disabledBlockIndent + DISABLEDFRAMES_FLAG +"\n";
            }

            lineCode = frame.frameType.allowChildren ?
                (Object.values(FrameContainersDefinitions).includes(frame.frameType)) ? 
                    this.parseFrames(store.getters.getFramesForParentId(frame.id)) :
                    this.parseBlock(frame, indent) 
                : 
                this.parseStatement(frame,indent);

            output += disabledFrameBlockFlag + lineCode;
        }

        return output;
    }

    public parse(): string {
        let output = "";

        console.time();
        output += this.parseFrames(store.getters.getFramesForParentId(0));
        // We could have disabled frame(s) just at the end of the code. 
        // Since no further frame would be used in the parse to close the ongoing comment block we need to check
        // if there are disabled frames being rendered when reaching the end of the editor's code.
        let disabledFrameBlockFlag = "";
        if(isDisabledFramesTriggered) {
            isDisabledFramesTriggered = !isDisabledFramesTriggered;
            disabledFrameBlockFlag = disabledBlockIndent + DISABLEDFRAMES_FLAG ;
        }
        console.timeEnd();

        return output + disabledFrameBlockFlag;
    }

    public getErrors(inputCode = ""): ErrorInfo[] {
        TPyParser.setLanguage("en");
        TPyParser.warningAsErrors = false;
        let code: string = inputCode;
        if (!inputCode) {
            code = this.parse();
        }

        const parsedCode = TPyParser.parse(code);
        console.log(parsedCode);

        // we need to built a simple AST of the code
        // to get all lexes and check if they exist.
        // Or we can simply run from L-to-R and 
        // get strings unless they are separated by 
        // () + - * / " " == ><= !=  or space 
        parsedCode["body"].forEach( (line) => {
            if(line.kind === "Assign") {
                //cases
                // Attribute -> Image.CAT
                // Constant -> "cat" or 1
                // Call -> x()
            }
        });

        return TPyParser.findAllErrors(code);
    }

    public getErrorsFormatted(inputCode = ""): string {
        const errors = this.getErrors(inputCode);
        let errorString = "";
        store.commit("clearAllErrors");
        
        if (errors.length > 0) {
            errorString = `${errors.map((e: any) => {
                return `\n${e.Ltigerpython_parser_ErrorInfo__f_line}:${e.Ltigerpython_parser_ErrorInfo__f_offset} | ${e.Ltigerpython_parser_ErrorInfo__f_msg}`;
            })}`;

            
            // For each error, show red border around its input in the UI
            errors.forEach((error: ErrorInfo) => {
                if( this.framePositionMap[error.line] !== undefined) {
                    if(this.isErrorIfInSlotBounds(error.line,error.offset)) {
                        store.commit("setSlotErroneous", {
                            frameId: this.framePositionMap[error.line].frameId,
                            // Get the slotIndex where the error's offset is ( i.e. slotStart[i]<= offset AND slotStart[i+1]?>offset)
                            slotIndex: this.framePositionMap[error.line].slotStarts.findIndex(
                                (element, index, array) => {
                                    return element<=error.offset && 
                                            ((index<array.length-1)? (array[index+1] > error.offset) : true)
                                }
                            ), 
                            error: error.msg,
                        });
                    }
                    else {
                        store.commit("setFrameErroneous", {
                            frameId: this.framePositionMap[error.line].frameId,
                            error: error.msg,
                        });
                    }
                }
            });

        }
        

        return errorString;
    }

    private isErrorIfInSlotBounds(errorLine: number, errorOffset: number) {

        for (let index = 0; index < this.framePositionMap[errorLine].slotLength.length; index++) {
            const slot = this.framePositionMap[errorLine];
            // if the error's offset is within the bounds of any slot, return true
            if(errorOffset >= slot.slotStarts[index] && errorOffset <= (slot.slotStarts[index] + slot.slotLength[index]-1)) {
                return true;
            }
        }
        // If the offset was inside none of the slots, then return false
        return false;
        
    }

}