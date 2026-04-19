import { motion, AnimatePresence } from 'framer-motion';
import { MarkdownText } from '../MarkdownText';

interface PlanChipExpandedContentProps {
  isExpanded: boolean;
  content: string;
}

export function PlanChipExpandedContent({ isExpanded, content }: PlanChipExpandedContentProps) {
  return (
    <AnimatePresence initial={false}>
      {isExpanded && content && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="overflow-hidden"
        >
          <div className="px-3 pb-3">
            <div className="text-sm text-muted-foreground border-t border-border/50 pt-3">
              <MarkdownText text={content} shouldAnimate={false} className="prose-sm" />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
