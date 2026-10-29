// The web job lifecycle owns the busy indicator; terminal rendering is CLI-only.
export const progressStep=()=>{};
export const withProgress=async(_message,task)=>task();
