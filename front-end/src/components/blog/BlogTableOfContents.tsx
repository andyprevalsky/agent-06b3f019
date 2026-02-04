/**
 * STATE MACHINE: BlogTableOfContents
 *
 * [MOUNTED] --> renders collapsible ToC accordion
 *   |
 *   +--> on click toggle --> expands/collapses ToC
 *   +--> on section click --> scrolls to section
 *
 * State: isOpen (boolean) - whether ToC is expanded
 */

import { useState } from 'react';
import { BlogSection } from '@/data/blogPosts';
import { ChevronUp } from 'lucide-react';

interface BlogTableOfContentsProps {
  sections: BlogSection[];
}

export default function BlogTableOfContents({ sections }: BlogTableOfContentsProps) {
  const [isOpen, setIsOpen] = useState(true);

  const handleClick = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-slate-50 transition-colors"
      >
        <span className="text-sm font-medium text-slate-700">Table of Contents</span>
        <ChevronUp
          className={`w-4 h-4 text-slate-500 transition-transform ${
            isOpen ? '' : 'rotate-180'
          }`}
        />
      </button>
      {isOpen && (
        <div className="px-6 pb-4 space-y-2">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => handleClick(section.id)}
              className="block text-left text-sm text-slate-600 hover:text-slate-900 transition-colors py-1"
            >
              {section.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
