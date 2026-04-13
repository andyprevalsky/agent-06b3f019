/**
 * STATE MACHINE: StreamingMarkdown
 *
 * TEXT_CHANGE:
 *   text grows → extract delta → append to chunks[]
 *   text resets → replace chunks with [text]
 *
 * RENDER:
 *   Each chunk fades in via motion.span opacity animation.
 */

import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

export function StreamingMarkdown({ text }: { text: string }) {
  const prevTextRef = useRef('');
  const [chunks, setChunks] = useState<string[]>([]);

  useEffect(() => {
    if (text.length > prevTextRef.current.length) {
      const delta = text.slice(prevTextRef.current.length);
      setChunks((prev) => [...prev, delta]);
      prevTextRef.current = text;
    } else if (text !== prevTextRef.current) {
      setChunks([text]);
      prevTextRef.current = text;
    }
  }, [text]);

  return (
    <span className="text-sm text-muted-foreground">
      {chunks.map((chunk, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        >
          {chunk}
        </motion.span>
      ))}
    </span>
  );
}
