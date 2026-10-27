"use client";
import { useEffect, type RefObject } from "react";
export function useDialogFocus<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const container = ref.current;
    const selector =
      'button:not([disabled]), a[href], input:not([disabled]), textarea, select, [tabindex="0"]';
    const first = container.querySelector<HTMLElement>(selector);
    first?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(
        container.querySelectorAll<HTMLElement>(selector),
      ).filter((el) => el.getClientRects().length > 0);
      const start = controls[0],
        end = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === start) {
        event.preventDefault();
        end?.focus();
      } else if (!event.shiftKey && document.activeElement === end) {
        event.preventDefault();
        start?.focus();
      }
    };
    container.addEventListener("keydown", trap);
    return () => {
      container.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [active, ref]);
}
