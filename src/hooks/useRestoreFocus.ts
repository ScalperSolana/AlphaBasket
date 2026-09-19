import { useEffect } from "react";

/**
 * Returns keyboard focus to whatever opened a route-driven panel.
 *
 * The panels are closed by navigating, which unmounts the dialog outright, so
 * Radix's own close-time focus restore never runs. Remember the element that
 * had focus when the panel mounted (the card or button that was activated) and
 * focus it again on unmount, if it is still in the document.
 */
export function useRestoreFocus(): void {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
}
