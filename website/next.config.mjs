import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

const nextConfig = {
  output: "export",
};

export default withMDX(nextConfig);
