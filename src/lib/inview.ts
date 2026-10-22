import type { Attachment } from 'svelte/attachments';

/** Attachment: calls `onNear` once, when the node gets within `rootMargin` (CSS margin syntax) of the viewport. */
export const inview =
  (rootMargin: string, onNear: () => void): Attachment<HTMLElement> =>
  (node) => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        onNear();
        observer.disconnect();
      },
      { rootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  };
