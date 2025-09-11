import { useMDXComponents as getThemeComponents } from "nextra-theme-docs";
import Giscus from "@/components/discussion/Giscus";
import QuizWrapper from "@/components/quiz/QuizWrapper";

export function useMDXComponents(components) {
  const themeComponents = getThemeComponents();
  
  // Override the wrapper to include Quiz and Giscus as bottomContent
  const customWrapper = (props) => {
    return themeComponents.wrapper({
      ...props,
      bottomContent: (
        <>
          <QuizWrapper darkMode={true} />
          <Giscus />
        </>
      )
    });
  };

  return {
    ...themeComponents,
    wrapper: customWrapper,
    ...components,
  };
}
