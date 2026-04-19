/**
 * Animates streaming attention text so each new delta fades in on arrival.
 *
 * STATE MACHINE:
 *   [FRESH]      <-- prevTextRef empty
 *      |  (text grows)
 *      v
 *   [APPENDING]  <-- chunks[] = previous deltas + new delta, each fades in
 *      |
 *      | (text shrinks / resets)
 *      v
 *   [RESET]      <-- chunks = [text]
 */
import { useEffect, useRef, useState } from 'react';

interface StreamingTextProps {
  text: string;
}

export function StreamingText({ text }: StreamingTextProps) {
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
    <span className="text-sm">
      {chunks.map((chunk, i) => (
        <span key={i} className="animate-in fade-in duration-300">
          {chunk}
        </span>
      ))}
    </span>
  );
}
