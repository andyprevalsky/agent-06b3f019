import React from 'react';
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import { baseMessage, renderBubble } from './message-bubble.fixtures';

describe('explicit final value presentation', () => {
  it('renders the accepted value as the whole answer instead of the report', () => {
    const message = baseMessage({ role: 'TOOL', text: '4', metadata: {
      toolName: 'completion_summary', toolStatus: 'FINISHED', isFinalSummary: true,
      completionSummary: { summary: 'Found the day', outputs: [{key:'day',label:'Wikipedia access day',value:4}],
        presentation: {version:1,mode:'value',field:'day',encoding:'text'}, answerText:'4' },
    }});
    const {container} = renderBubble(<MessageBubble message={message} />);
    expect(container.querySelector('[data-final-answer]')?.textContent).toBe('4');
    expect(screen.queryByText('Found the day')).not.toBeInTheDocument();
    expect(screen.queryByText('Wikipedia access day')).not.toBeInTheDocument();
  });
  it('keeps legacy reports visible and never interprets an answer as HTML', () => {
    const message = baseMessage({ role:'TOOL',metadata:{toolName:'completion_summary',toolStatus:'FINISHED',isFinalSummary:true,
      completionSummary:{summary:'Ordinary report',outputs:[{key:'day',label:'Day',value:4}]}}});
    renderBubble(<MessageBubble message={message} />);
    expect(screen.getByText('Ordinary report')).toBeInTheDocument();
    const unsafe = baseMessage({role:'TOOL',text:'<img src=x onerror=alert(1)>',metadata:{toolName:'completion_summary',toolStatus:'FINISHED',isFinalSummary:true,
      completionSummary:{summary:'Hidden report',presentation:{version:1,mode:'value',field:'text',encoding:'text'},answerText:'<img src=x onerror=alert(1)>'}}});
    const {container}=renderBubble(<MessageBubble message={unsafe}/>);
    expect(container.querySelector('[data-final-answer]')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(container.querySelector('[data-final-answer] img')).toBeNull();
  });
});
