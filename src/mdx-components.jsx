import { useMDXComponents as getThemeComponents } from "nextra-theme-docs";
import Giscus from "@/components/discussion/Giscus";

export function useMDXComponents(components) {
  const themeComponents = getThemeComponents();
  
  // Override the wrapper to include Giscus as bottomContent
  const customWrapper = (props) => {
    return themeComponents.wrapper({
      ...props,
      bottomContent: <Giscus />
    });
  };

  return {
    ...themeComponents,
    wrapper: customWrapper,
    ...components,
  };
}
