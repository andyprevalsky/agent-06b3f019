/**
 * STATE MACHINE: VideoLoadingAnimation
 *
 * This is a stateless presentational component.
 *
 * [VISIBLE] <-- isVisible: true --> renders animated loading dots
 * [HIDDEN] <-- isVisible: false --> returns null
 */

import React from 'react';

import type { VideoLoadingAnimationProps } from '../types';

const VideoLoadingAnimation: React.FC<VideoLoadingAnimationProps> = ({ isVisible }) => {
  if (!isVisible) return null;

  return (
    <>
      <div className="absolute inset-0 flex flex-col items-center justify-center z-20">
        <div className="text-sm text-foreground/70 mb-6 font-medium tracking-wide">loading</div>
        <div className="flex items-center space-x-2">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="w-4 h-4 box">
              <svg width="16" height="16" viewBox="0 0 16 16" className="w-full h-full">
                <g className="box-group">
                  <path
                    d="M2 2 Q 8 3 14 2 Q 13 8 14 14 Q 8 13 2 14 Q 3 8 2 2 Z"
                    fill="transparent"
                    stroke="hsl(240 15% 8%)"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M2 2 Q 8 3 14 2 Q 13 8 14 14 Q 8 13 2 14 Q 3 8 2 2 Z"
                    fill="hsl(240 15% 8%)"
                    stroke="hsl(240 15% 8%)"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    opacity="0"
                    className="box-fill"
                  />
                </g>
              </svg>
            </div>
          ))}
        </div>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
          /* Cumulative left-to-right fill: 6 steps total */
          /* Duration can be tuned, but all five boxes share the same cycle */
          .box-group { transform-origin: 50% 50%; }

          .box:nth-child(1) .box-fill { animation: fill1 2.4s ease-in-out infinite; }
          .box:nth-child(2) .box-fill { animation: fill2 2.4s ease-in-out infinite; }
          .box:nth-child(3) .box-fill { animation: fill3 2.4s ease-in-out infinite; }
          .box:nth-child(4) .box-fill { animation: fill4 2.4s ease-in-out infinite; }
          .box:nth-child(5) .box-fill { animation: fill5 2.4s ease-in-out infinite; }

          /* Steps: [0-16.666%): 1 box, [16.666-33.333%): 2, [33.333-50%): 3, [50-66.666%): 4, [66.666-83.333%): 5, [83.333-100%): 0 */
          /* 6-step cycle with smooth fades */
          /* Step windows (approx):
             S1: 0–16.666, S2: 16.666–33.333, S3: 33.333–50,
             S4: 50–66.666, S5: 66.666–83.333, S6: 83.333–100 */
          @keyframes fill1 {
            0% { opacity: 0; }
            3% { opacity: 1; }
            83.333% { opacity: 1; }
            93.333% { opacity: 0; }
            100% { opacity: 0; }
          }
          @keyframes fill2 {
            0% { opacity: 0; }
            16.666% { opacity: 0; }
            19.666% { opacity: 1; }
            83.333% { opacity: 1; }
            93.333% { opacity: 0; }
            100% { opacity: 0; }
          }
          @keyframes fill3 {
            0% { opacity: 0; }
            33.333% { opacity: 0; }
            36.333% { opacity: 1; }
            83.333% { opacity: 1; }
            93.333% { opacity: 0; }
            100% { opacity: 0; }
          }
          @keyframes fill4 {
            0% { opacity: 0; }
            50% { opacity: 0; }
            53% { opacity: 1; }
            83.333% { opacity: 1; }
            93.333% { opacity: 0; }
            100% { opacity: 0; }
          }
          @keyframes fill5 {
            0% { opacity: 0; }
            66.666% { opacity: 0; }
            69.666% { opacity: 1; }
            83.333% { opacity: 1; }
            93.333% { opacity: 0; }
            100% { opacity: 0; }
          }
        `,
        }}
      />
    </>
  );
};

export default VideoLoadingAnimation;
