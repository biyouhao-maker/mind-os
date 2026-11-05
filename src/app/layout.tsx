import type {Metadata} from "next";
import "./globals.css";
export const metadata:Metadata={title:"MIND OS — Personal Intelligence OS",description:"Your Personal Intelligence Operating System"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>;}
