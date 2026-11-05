import {defaults,type AppData} from "./types";
export const KEY="mind-os-data-v2";
export function readData():AppData{if(typeof window==="undefined")return defaults;try{const v=JSON.parse(localStorage.getItem(KEY)||"null") as Partial<AppData>|null;if(!v)return defaults;return {...defaults,...v,profile:{...defaults.profile,...v.profile},platforms:v.platforms?.length?v.platforms:defaults.platforms};}catch{return defaults;}}
export function writeData(data:AppData){if(typeof window!=="undefined")localStorage.setItem(KEY,JSON.stringify(data));}
