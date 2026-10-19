import { motion } from "motion/react";
import { spring, tween } from "../motion";

/**
 * The ACTIVE / PENDING tag. One per entity, shared layoutId, so it slides between cards (SPEC §7).
 * With reduced motion it crossfades in place instead.
 */
export function SelectionTag({
  entityId,
  pending,
  reduced,
  shared = true,
}: {
  entityId: string;
  pending: boolean;
  reduced: boolean;
  /** false: crossfade in place (detail views, where a tag flying in from another page would look odd) */
  shared?: boolean;
}) {
  const cls = `tag ${pending ? "tag--pending" : "tag--active"}`;
  if (reduced || !shared) {
    return (
      <motion.span className={cls} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: tween.small }} exit={{ opacity: 0, transition: tween.micro }}>
        {pending ? "Pending" : "Active"}
      </motion.span>
    );
  }
  return (
    <motion.span layoutId={`tag-${entityId}`} className={cls} transition={spring.snappy}>
      {pending ? "Pending" : "Active"}
    </motion.span>
  );
}

