/**
 * Pill-shaped Quick-Query launcher component.
 *
 * Thin view: reads state + handlers from `useLauncher`, renders the shader
 * backdrop + form. All IO (IPC, focus, submit) is orchestrated in hooks.ts.
 */

import ShaderTile from './ShaderTile';
import QueryForm from './QueryForm';
import { useLauncher } from '../hooks';
import { LAUNCHER_PILL_HEIGHT, LAUNCHER_PILL_WIDTH } from '../config';

const Launcher = (): React.JSX.Element => {
  const { query, setQuery, submitting, inputRef, handleSubmit, handleKeyDown } = useLauncher();

  return (
    <div className="drag-region" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        className="drag-region"
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: LAUNCHER_PILL_WIDTH,
          height: LAUNCHER_PILL_HEIGHT,
          borderRadius: 9999,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15), 0 2px 4px rgba(0, 0, 0, 0.1)',
        }}
      >
        {/* Shader background */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 9999,
            overflow: 'hidden',
          }}
        >
          <ShaderTile size={LAUNCHER_PILL_HEIGHT} />
        </div>

        {/* Inner content */}
        <div
          style={{
            position: 'absolute',
            top: 2,
            left: 2,
            right: 2,
            bottom: 2,
            borderRadius: 9999,
            backgroundColor: '#f5f5f5',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <QueryForm
            query={query}
            setQuery={setQuery}
            submitting={submitting}
            inputRef={inputRef}
            handleSubmit={handleSubmit}
            handleKeyDown={handleKeyDown}
          />
        </div>
      </div>
    </div>
  );
};

export default Launcher;
