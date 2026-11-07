import {defaults,type AppData} from "./types";
export const KEY="mind-os-data-v2";
export function readData():AppData{if(typeof window==="undefined")return defaults;try{const v=JSON.parse(localStorage.getItem(KEY)||"null") as Partial<AppData>|null;if(!v)return defaults;const merged={...defaults,...v,profile:{...defaults.profile,...v.profile},platforms:v.platforms?.length?v.platforms:defaults.platforms};
/* 平台注册表迁移：新版本新增的平台（如 Kimi、豆包）自动补进老数据，已有平台保留用户状态 */
const known=new Set(merged.platforms.map(p=>p.name));
const missing=defaults.platforms.filter(p=>!known.has(p.name));
if(missing.length)merged.platforms=[...merged.platforms,...missing];
return merged;}catch{return defaults;}}
export function writeData(data:AppData){if(typeof window!=="undefined")localStorage.setItem(KEY,JSON.stringify(data));}
