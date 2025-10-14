import React, { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface MarkdownTextProps {
  text: string;
  shouldAnimate?: boolean;
  onComplete?: () => void;
  className?: string;
}

interface WordItem {
  word: string;
  isWord: boolean;
  isBold?: boolean;
  isItalic?: boolean;
  isLink?: boolean;
  href?: string;
  isCode?: boolean;
  blockType?: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'li' | 'blockquote' | 'pre';
  blockStart?: boolean; // First word in a block
  blockEnd?: boolean; // Last word in a block
  listType?: 'ul' | 'ol'; // Parent list type for li elements
}

/**
 * FadeInMarkdown - Animated markdown that fades in word by word
 * Preserves markdown formatting by extracting words with their style metadata
 */
function FadeInMarkdown({
  markdown,
  onComplete,
  className,
  shouldAnimate = true,
}: {
  markdown: string;
  onComplete?: () => void;
  className?: string;
  shouldAnimate?: boolean;
}) {
  const reduce = useReducedMotion();
  const tempRef = useRef<HTMLDivElement>(null);
  const [words, setWords] = useState<WordItem[]>([]);

  // Step 1: Render markdown to hidden div, extract words with formatting
  useEffect(() => {
    if (!tempRef.current) return;

    const wordArray: WordItem[] = [];

    // Walk the DOM and extract text with formatting info
    const extractWords = (node: Node, formatting: Partial<WordItem> = {}): void => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent) {
        const text = node.textContent;
        if (text.trim().length === 0) {
          // Just whitespace - still needs ALL metadata
          wordArray.push({ 
            word: text, 
            isWord: false,
            blockStart: false,
            blockEnd: false,
            ...formatting 
          });
          return;
        }

        // Split into words and whitespace
        const parts = text.split(/(\s+)/);
        parts.forEach((part, idx) => {
          if (part.trim().length > 0) {
            // It's a word
            wordArray.push({
              word: part,
              isWord: true,
              blockStart: idx === 0 && parts.length > 1,
              blockEnd: idx === parts.length - 1 && parts.length > 1,
              ...formatting
            });
          } else if (part.length > 0) {
            // It's whitespace - still needs ALL metadata
            wordArray.push({ 
              word: part, 
              isWord: false,
              blockStart: false,
              blockEnd: false,
              ...formatting 
            });
          }
        });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        const tagName = element.tagName.toLowerCase();
        
        // Build formatting based on element type
        const newFormatting = { ...formatting };
        
        // Inline formatting
        if (tagName === 'strong' || tagName === 'b') {
          newFormatting.isBold = true;
        }
        if (tagName === 'em' || tagName === 'i') {
          newFormatting.isItalic = true;
        }
        if (tagName === 'a') {
          newFormatting.isLink = true;
          newFormatting.href = element.getAttribute('href') || undefined;
        }
        if (tagName === 'code') {
          newFormatting.isCode = true;
        }
        
        // Block-level elements - blockquote and pre take priority over p
        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre'].includes(tagName)) {
          newFormatting.blockType = tagName as any;
        } else if (tagName === 'p' && !formatting.blockType) {
          // Only set p if we don't already have a blockType (e.g., from blockquote)
          newFormatting.blockType = 'p';
        }
        
        // Track parent list type for li elements
        if (tagName === 'ul' || tagName === 'ol') {
          newFormatting.listType = tagName as 'ul' | 'ol';
        }
        
        // Recurse through children
        Array.from(node.childNodes).forEach(child => {
          extractWords(child, newFormatting);
        });
      }
    };

    extractWords(tempRef.current);
    
    console.log('📝 Extracted 1D word array:', wordArray);
    console.log('📊 Total parts:', wordArray.length, '| Words only:', wordArray.filter(w => w.isWord).length);
    console.log('🔍 Code block items:', wordArray.filter(w => w.blockType === 'pre'));
    console.log('🔍 Items without blockType:', wordArray.filter(w => !w.blockType));
    
    setWords(wordArray);
  }, [markdown]);

  // Step 2: When animation completes
  const handleLastWordComplete = () => {
    console.log('✅ Animation complete!');
    if (onComplete) {
      onComplete();
    }
  };

  // If words haven't been extracted yet, render hidden markdown
  if (words.length === 0) {
  return (
      <div ref={tempRef} style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {markdown}
        </ReactMarkdown>
      </div>
    );
  }

  // Step 3: Render each word with its formatting preserved
  const wordCount = words.filter(w => w.isWord).length;
  let wordIndex = 0;
  
  // Calculate dynamic delay based on word count to ensure 3s max animation
  const maxAnimationTime = 3.0; // seconds
  const baseDelay = 0.05; // initial delay before first word
  const fadeDuration = 0.35; // duration for each word fade-in
  const availableTime = maxAnimationTime - baseDelay - fadeDuration;
  const perWordDelay = Math.min(0.04, availableTime / Math.max(wordCount, 1));
  
  // Group words by blocks for proper rendering
  const renderWords = (animate: boolean) => {
    const elements: React.ReactNode[] = [];
    let currentBlock: React.ReactNode[] = [];
    let currentBlockType: string | undefined = undefined;
    let listItems: React.ReactNode[] = [];
    let currentListType: 'ul' | 'ol' | undefined = undefined;
    let currentBlockFirstWordIndex = 0; // Track first word index for block animation
    
    // Group consecutive words with same inline formatting
    let inlineGroup: typeof words[0][] = [];
    let lastFormatting: string = '';
    let inlineGroupFirstWordIndex = 0; // Track first word index for inline code animation
    
    const flushInlineGroup = () => {
      if (inlineGroup.length === 0) return null;
      
      const firstItem = inlineGroup[0];
      const groupKey = `group-${currentBlock.length}`;
      const groupFirstWordIndex = inlineGroupFirstWordIndex; // Capture for animation
      
      // For inline code, separate leading/trailing whitespace from the code content
      let processedGroup = [...inlineGroup];
      let leadingWhitespace: typeof words[0] | null = null;
      let trailingWhitespace: typeof words[0] | null = null;
      
      if (firstItem.isCode && firstItem.blockType !== 'pre') {
        // Extract leading whitespace
        if (processedGroup.length > 0 && !processedGroup[0].isWord) {
          leadingWhitespace = processedGroup.shift()!;
        }
        // Extract trailing whitespace
        if (processedGroup.length > 0 && !processedGroup[processedGroup.length - 1].isWord) {
          trailingWhitespace = processedGroup.pop()!;
        }
      }
      
      // Create animated/static spans for each word in the group
      const wordSpans = processedGroup.map((item, idx) => {
        let content;
        
        if (animate && !reduce) {
          const currentWordIndex = wordIndex;
          wordIndex++;
          const delay = baseDelay + (currentWordIndex * perWordDelay);
          const isLastWord = currentWordIndex === wordCount - 1;
          
          content = (
            <motion.span
              key={`word-${wordIndex}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                delay,
                duration: 0.35,
                ease: 'easeOut'
              }}
              onAnimationComplete={isLastWord ? handleLastWordComplete : undefined}
            >
              {item.word}
            </motion.span>
          );
        } else {
          wordIndex++;
          content = <span key={`word-${wordIndex}`}>{item.word}</span>;
        }
        
        return content;
      });
      
      let groupContent = <React.Fragment key={groupKey}>{wordSpans}</React.Fragment>;
      
      // Wrap the entire group with formatting
      if (firstItem.isCode) {
        // Animate inline code pill (not code blocks)
        if (firstItem.blockType !== 'pre' && animate && !reduce) {
          const delay = baseDelay + (groupFirstWordIndex * perWordDelay);
          groupContent = (
            <motion.code
              key={groupKey}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                delay,
                duration: 0.35,
                ease: 'easeOut'
              }}
            >
              {wordSpans}
            </motion.code>
          );
        } else {
          groupContent = (
            <code key={groupKey}>
              {wordSpans}
            </code>
          );
        }
      } else {
        if (firstItem.isBold) {
          groupContent = <strong key={groupKey}>{wordSpans}</strong>;
        }
        if (firstItem.isItalic) {
          const wrapped = groupContent;
          groupContent = <em key={`${groupKey}-em`}>{wrapped}</em>;
        }
        if (firstItem.isLink && firstItem.href) {
          const wrapped = groupContent;
          groupContent = <a key={`${groupKey}-link`} href={firstItem.href}>{wrapped}</a>;
        }
      }
      
      // For inline code, add back the leading/trailing whitespace outside the code element
      if (firstItem.isCode && firstItem.blockType !== 'pre') {
        return (
          <React.Fragment key={groupKey}>
            {leadingWhitespace && leadingWhitespace.word}
            {groupContent}
            {trailingWhitespace && trailingWhitespace.word}
          </React.Fragment>
        );
      }
      
      return groupContent;
    };
    
    words.forEach((item, index) => {
      if (!item.isWord) {
        // For whitespace, keep it in group if we're in an inline code or link group (not pre/code blocks)
        const isInInlineCodeGroup = inlineGroup.length > 0 && 
                                    inlineGroup[0].isCode && 
                                    inlineGroup[0].blockType !== 'pre';
        const isInLinkGroup = inlineGroup.length > 0 && inlineGroup[0].isLink;
        
        if (isInInlineCodeGroup || isInLinkGroup) {
          inlineGroup.push(item);
        } else {
          // Flush group and add whitespace normally
          const flushed = flushInlineGroup();
          if (flushed) currentBlock.push(flushed);
          inlineGroup = [];
          lastFormatting = '';
          currentBlock.push(<React.Fragment key={index}>{item.word}</React.Fragment>);
        }
        return;
      }
      
      // Check if we need to start a new block
      const isListItem = item.blockType === 'li';
      const shouldStartNewBlock = item.blockType && 
        (item.blockType !== currentBlockType || 
         (isListItem && item.blockStart)) &&
        currentBlock.length > 0;
        
      if (shouldStartNewBlock) {
        // Flush inline group
        const flushed = flushInlineGroup();
        if (flushed) currentBlock.push(flushed);
        inlineGroup = [];
        lastFormatting = '';
        
        // Finish current block
        if (currentBlockType === 'li') {
          // Add list item to collection with animation
          const blockDelay = baseDelay + (currentBlockFirstWordIndex * perWordDelay);
          if (animate && !reduce) {
            listItems.push(
              <motion.li
                key={`li-${listItems.length}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  delay: blockDelay,
                  duration: 0.35,
                  ease: 'easeOut'
                }}
              >
                {currentBlock}
              </motion.li>
            );
          } else {
            listItems.push(<li key={`li-${listItems.length}`}>{currentBlock}</li>);
          }
          currentBlock = [];
          
          // If next block is NOT a list item, flush the accumulated list
          if (!isListItem && listItems.length > 0 && currentListType) {
            const ListTag = currentListType as any;
            elements.push(<ListTag key={`list-${elements.length}`}>{listItems}</ListTag>);
            listItems = [];
            currentListType = undefined;
          }
        } else {
          // Flush any accumulated list items first
          if (listItems.length > 0 && currentListType) {
            const ListTag = currentListType as any;
            elements.push(<ListTag key={`list-${elements.length}`}>{listItems}</ListTag>);
            listItems = [];
            currentListType = undefined;
          }
          
          // Then add the current block
          if (currentBlockType) {
            const BlockTag = currentBlockType as any;
            const blockDelay = baseDelay + (currentBlockFirstWordIndex * perWordDelay);
            
            // Animate special block types
            if ((currentBlockType === 'blockquote' || currentBlockType === 'pre') && animate && !reduce) {
              if (currentBlockType === 'blockquote') {
                elements.push(
                  <motion.blockquote
                    key={`block-${elements.length}`}
                    className="custom-blockquote"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                      delay: blockDelay,
                      duration: 0.35,
                      ease: 'easeOut'
                    }}
                  >
                    {currentBlock}
                  </motion.blockquote>
                );
              } else {
                elements.push(
                  <motion.pre
                    key={`block-${elements.length}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                      delay: blockDelay,
                      duration: 0.35,
                      ease: 'easeOut'
                    }}
                  >
                    {currentBlock}
                  </motion.pre>
                );
              }
            } else {
              if (currentBlockType === 'blockquote') {
                elements.push(
                  <BlockTag key={`block-${elements.length}`} className="custom-blockquote">
                    {currentBlock}
                  </BlockTag>
                );
              } else {
                elements.push(<BlockTag key={`block-${elements.length}`}>{currentBlock}</BlockTag>);
              }
            }
          } else {
            elements.push(...currentBlock);
          }
          currentBlock = [];
        }
      }
      
      // Track list type for li elements
      if (isListItem && item.listType) {
        // If list type changed, flush previous list
        if (currentListType && currentListType !== item.listType && listItems.length > 0) {
          const ListTag = currentListType as any;
          elements.push(<ListTag key={`list-${elements.length}`}>{listItems}</ListTag>);
          listItems = [];
        }
        currentListType = item.listType;
      }
      
      currentBlockType = item.blockType;
      
      // Track first word index when starting a new block
      if (currentBlock.length === 0) {
        currentBlockFirstWordIndex = wordIndex;
      }
      
      // Create formatting key for grouping
      const formatting = `${item.isBold || ''}-${item.isItalic || ''}-${item.isCode || ''}-${item.isLink || ''}-${item.href || ''}`;
      
      // If formatting changed, flush previous group
      if (formatting !== lastFormatting && inlineGroup.length > 0) {
        const flushed = flushInlineGroup();
        if (flushed) currentBlock.push(flushed);
        inlineGroup = [];
      }
      
      lastFormatting = formatting;
      
      // Track first word index when starting a new inline group
      if (inlineGroup.length === 0) {
        inlineGroupFirstWordIndex = wordIndex;
      }
      
      inlineGroup.push(item);
    });
    
    // Flush any remaining inline group
    const flushed = flushInlineGroup();
    if (flushed) currentBlock.push(flushed);
    
    // Flush remaining block
    if (currentBlock.length > 0) {
      if (currentBlockType === 'li') {
        // Add final list item with animation
        const blockDelay = baseDelay + (currentBlockFirstWordIndex * perWordDelay);
        if (animate && !reduce) {
          listItems.push(
            <motion.li
              key={`li-${listItems.length}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                delay: blockDelay,
                duration: 0.35,
                ease: 'easeOut'
              }}
            >
              {currentBlock}
            </motion.li>
          );
        } else {
          listItems.push(<li key={`li-${listItems.length}`}>{currentBlock}</li>);
        }
      } else {
        // Flush any accumulated list items first
        if (listItems.length > 0 && currentListType) {
          const ListTag = currentListType as any;
          elements.push(<ListTag key={`list-${elements.length}`}>{listItems}</ListTag>);
          listItems = [];
        }
        
        // Then add the current block
        if (currentBlockType) {
          const BlockTag = currentBlockType as any;
          const blockDelay = baseDelay + (currentBlockFirstWordIndex * perWordDelay);
          
          // For code blocks, trim trailing newlines
          let blockContent = [...currentBlock];
          if (currentBlockType === 'pre') {
            console.log('🔍 Code block content BEFORE trim:', blockContent);
            console.log('🔍 Last item:', blockContent[blockContent.length - 1]);
            
            // Remove trailing whitespace/newline-only fragments
            while (blockContent.length > 0) {
              const lastItem = blockContent[blockContent.length - 1];
              // Check if it's a Fragment with only whitespace or newlines
              if (React.isValidElement(lastItem) && 
                  lastItem.type === React.Fragment) {
                const children = lastItem.props.children;
                // Match whitespace, newlines, or any combination
                if (typeof children === 'string' && /^[\s\n]*$/.test(children)) {
                  console.log('🗑️ Removing trailing whitespace/newline:', JSON.stringify(children));
                  blockContent.pop();
                  continue;
                }
              }
              break;
            }
            
            console.log('✅ Code block content AFTER trim:', blockContent);
          }
          
          // Animate special block types
          if ((currentBlockType === 'blockquote' || currentBlockType === 'pre') && animate && !reduce) {
            if (currentBlockType === 'blockquote') {
              elements.push(
                <motion.blockquote
                  key={`block-${elements.length}`}
                  className="custom-blockquote"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{
                    delay: blockDelay,
                    duration: 0.35,
                    ease: 'easeOut'
                  }}
                >
                  {blockContent}
                </motion.blockquote>
              );
            } else {
              elements.push(
                <motion.pre
                  key={`block-${elements.length}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{
                    delay: blockDelay,
                    duration: 0.35,
                    ease: 'easeOut'
                  }}
                >
                  {blockContent}
                </motion.pre>
              );
            }
          } else {
            if (currentBlockType === 'blockquote') {
              elements.push(
                <BlockTag key={`block-${elements.length}`} className="custom-blockquote">
                  {blockContent}
                </BlockTag>
              );
            } else {
              elements.push(<BlockTag key={`block-${elements.length}`}>{blockContent}</BlockTag>);
            }
          }
        } else {
          elements.push(...currentBlock);
        }
      }
    }
    
    // Final flush of any remaining list items
    if (listItems.length > 0 && currentListType) {
      const ListTag = currentListType as any;
      elements.push(<ListTag key={`list-${elements.length}`}>{listItems}</ListTag>);
    }
    
    return elements;
  };
  
  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
      <style>{`
        /* Enhanced inline code styling */
        .prose code:not(pre code) {
          background-color: rgb(226 232 240);
          padding: 0.125rem 0.375rem;
          border-radius: 0.25rem;
          font-size: 0.875em;
          font-weight: 400;
          border: 1px solid rgb(203 213 225);
        }
        /* Remove backticks added by Tailwind prose */
        .prose code:not(pre code)::before,
        .prose code:not(pre code)::after {
          content: '' !important;
        }
        .dark .prose code:not(pre code) {
          background-color: rgb(30 41 59);
          color: rgb(226 232 240);
          border-color: rgb(51 65 85);
        }
        
        /* Blockquote styling - using custom class for specificity */
        .custom-blockquote {
          border-left: 4px solid rgb(203 213 225) !important;
          padding-left: 1rem !important;
          font-style: italic !important;
          color: rgb(71 85 105) !important;
          margin: 1.5em 0 !important;
        }
        .dark .custom-blockquote {
          border-left-color: rgb(51 65 85) !important;
          color: rgb(148 163 184) !important;
        }
        
        /* Also target prose blockquote as fallback */
        .prose blockquote {
          border-left: 4px solid rgb(203 213 225) !important;
          padding-left: 1rem !important;
          font-style: italic !important;
          color: rgb(71 85 105) !important;
          margin: 1.5em 0 !important;
        }
        .dark .prose blockquote {
          border-left-color: rgb(51 65 85) !important;
          color: rgb(148 163 184) !important;
        }
        
        /* Code block styling */
        .prose pre {
          background-color: rgb(241 245 249);
          padding: 1rem;
          border-radius: 0.5rem;
          overflow-x: auto;
          margin: 1.5em 0;
          white-space: pre;
        }
        .dark .prose pre {
          background-color: rgb(15 23 42);
        }
        .prose pre code {
          background-color: transparent;
          padding: 0;
          border: none;
          font-size: 0.875em;
          color: rgb(30 41 59);
          white-space: pre;
        }
        .dark .prose pre code {
          color: rgb(226 232 240);
        }
        
        /* Paragraph spacing */
        .prose p {
          margin: 1em 0;
        }
        .prose p:first-child {
          margin-top: 0;
        }
        .prose p:last-child {
          margin-bottom: 0;
        }
        
        /* List styling */
        .prose ul, .prose ol {
          margin: 1.5em 0;
          padding-left: 1.5em;
          list-style-position: outside;
        }
        .prose ul {
          list-style-type: disc;
        }
        .prose ol {
          list-style-type: decimal;
        }
        .prose li {
          margin: 0.5em 0;
          padding-left: 0.25em;
        }
        
        /* Link styling */
        .prose a {
          color: rgb(37 99 235);
          text-decoration: none;
        }
        .dark .prose a {
          color: rgb(96 165 250);
        }
        .prose a:hover {
          text-decoration: underline;
        }
      `}</style>
      {renderWords(shouldAnimate && !reduce)}
    </div>
  );
}

/**
 * MarkdownText - Component that renders markdown with optional animation
 */
export const MarkdownText = memo(function MarkdownText({ 
  text, 
  shouldAnimate = false, 
  onComplete,
  className 
}: MarkdownTextProps) {
  
  // Always use FadeInMarkdown for consistent styling
  return (
    <FadeInMarkdown
      markdown={text}
      onComplete={onComplete}
      className={className}
      shouldAnimate={shouldAnimate}
    />
  );
});



