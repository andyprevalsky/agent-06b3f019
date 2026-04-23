/**
 * STATE MACHINE: FeedbackBanner
 *
 * FEEDBACK FLOW:
 * [RATING] <-- step: 'rating'
 *     |
 *     | (select 1-5 stars)
 *     v
 * [DETAILS] <-- step: 'details' (if rating < 5)
 *     |         - issueType: string
 *     |         - comment: string
 *     |         - helpImprove: boolean
 *     |
 *     | (submit)
 *     v
 * [SUBMITTING] <-- isSubmitting: true
 *     |
 *     v (success)
 * [THANK_YOU] <-- step: 'thankyou'
 *
 * Layout: Full width, no internal spacers. Parent handles spacing.
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { FeedbackData } from '../types';

export type { FeedbackData } from '../types';

interface FeedbackBannerProps {
  onSubmit: (feedback: FeedbackData) => Promise<void>;
}

const ISSUE_TYPES = [
  'Non-AI bug',
  'Agent is stuck or loops',
  'Output is cut off or missing file',
  'Output is too simple',
  'Output is too ugly',
  'Output is factually incorrect',
  "Didn't follow instructions",
  'Forget or confuse context',
  'Cost is too high',
  'Report inappropriate content',
  'Other (please comment)',
];

const BANNER_STYLE: React.CSSProperties = {
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  backgroundColor: 'rgba(255, 255, 255, 0.1)',
};

interface StarRatingProps {
  selectedRating: number;
  hoveredStar: number;
  onHover: (n: number) => void;
  onClick: (n: number) => void;
}

function StarRating({ selectedRating, hoveredStar, onHover, onClick }: StarRatingProps) {
  return (
    <div className="flex items-center justify-between py-2 px-4">
      <span className="text-sm text-muted-foreground">How was this result?</span>
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            className="focus:outline-none transition-transform hover:scale-110 p-0.5"
            onMouseEnter={() => onHover(star)}
            onMouseLeave={() => onHover(0)}
            onClick={() => onClick(star)}
          >
            <Star
              className={cn(
                'w-5 h-5 transition-colors',
                hoveredStar >= star || selectedRating >= star
                  ? 'fill-yellow-400 text-yellow-400'
                  : 'text-muted-foreground',
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

interface DetailsPanelProps {
  issueType: string;
  setIssueType: (v: string) => void;
  comment: string;
  setComment: (v: string) => void;
  helpImprove: boolean;
  setHelpImprove: (v: boolean) => void;
  isSubmitting: boolean;
  selectedRating: number;
  onCancel: () => void;
  onSubmit: () => void;
}

function DetailsPanelContent({
  issueType,
  setIssueType,
  comment,
  setComment,
  helpImprove,
  setHelpImprove,
  isSubmitting,
  selectedRating,
  onCancel,
  onSubmit,
}: DetailsPanelProps) {
  return (
    <div className="p-4 space-y-4">
      <div className="space-y-2">
        <label className="text-sm text-muted-foreground">Issue type (optional)</label>
        <Select value={issueType} onValueChange={setIssueType}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Please select" />
          </SelectTrigger>
          <SelectContent>
            {ISSUE_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <label className="text-sm text-muted-foreground">Comment (optional)</label>
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Additional feedback"
          className="resize-none"
          rows={3}
        />
      </div>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="helpImprove"
            checked={helpImprove}
            onCheckedChange={(checked) => setHelpImprove(checked === true)}
          />
          <label htmlFor="helpImprove" className="text-sm text-muted-foreground cursor-pointer">
            Help Rose improve with my feedback
          </label>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={isSubmitting || selectedRating === 0}>
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SubmittedBanner() {
  return (
    <div
      className="flex items-center gap-2 py-2 px-4 rounded-lg border border-border"
      style={BANNER_STYLE}
    >
      <Check className="w-4 h-4 text-green-500" />
      <span className="text-sm text-muted-foreground">Thanks for your feedback!</span>
    </div>
  );
}

export function FeedbackBanner({ onSubmit }: FeedbackBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [hoveredStar, setHoveredStar] = useState(0);
  const [selectedRating, setSelectedRating] = useState(0);
  const [issueType, setIssueType] = useState<string>('');
  const [comment, setComment] = useState('');
  const [helpImprove, setHelpImprove] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleStarClick = (rating: number) => {
    setSelectedRating(rating);
    setIsExpanded(true);
  };

  const handleSubmit = async () => {
    if (selectedRating === 0) return;
    setIsSubmitting(true);
    try {
      await onSubmit({
        rating: selectedRating,
        issueType: issueType || undefined,
        comment: comment || undefined,
        helpImprove,
      });
      setIsSubmitted(true);
    } catch (error) {
      console.error('Failed to submit feedback:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setIsExpanded(false);
    setSelectedRating(0);
    setIssueType('');
    setComment('');
  };

  if (isSubmitted) return <SubmittedBanner />;

  return (
    <motion.div
      className="w-full rounded-lg border border-border overflow-hidden"
      style={BANNER_STYLE}
      layout
    >
      <StarRating
        selectedRating={selectedRating}
        hoveredStar={hoveredStar}
        onHover={setHoveredStar}
        onClick={handleStarClick}
      />
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-border"
          >
            <DetailsPanelContent
              issueType={issueType}
              setIssueType={setIssueType}
              comment={comment}
              setComment={setComment}
              helpImprove={helpImprove}
              setHelpImprove={setHelpImprove}
              isSubmitting={isSubmitting}
              selectedRating={selectedRating}
              onCancel={handleCancel}
              onSubmit={() => void handleSubmit()}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
