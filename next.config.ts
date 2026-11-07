import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * leancloud-storage 的 Node 适配器包含动态 require（formidable），
   * 无法被打包器静态解析。将其标记为服务端外部包：
   * 服务端构建不再打包它（我们的 LeanCloud 调用只发生在浏览器端）。
   */
  serverExternalPackages: ["leancloud-storage"]
};

export default nextConfig;
