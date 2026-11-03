/** Release the thumb's owned animation loop when its scroll effect exits. */
const VERSIONS = new Set(['1.2.16', '1.3.0']);
const ORIGINAL = `        viewport.addEventListener("scroll", handleScroll);
        return () => viewport.removeEventListener("scroll", handleScroll);
      }
    }, [scrollAreaContext.viewport, debounceScrollEnd, onThumbPositionChange]);`;
const PATCHED = `        viewport.addEventListener("scroll", handleScroll);
        return () => {
          viewport.removeEventListener("scroll", handleScroll);
          removeUnlinkedScrollListenerRef.current?.();
          removeUnlinkedScrollListenerRef.current = void 0;
        };
      }
    }, [scrollAreaContext.viewport, debounceScrollEnd, onThumbPositionChange]);`;

export function transformRadixScrollArea(source, version) {
  if (!VERSIONS.has(version)) throw new Error(`Unsupported Radix scroll-area version: ${version}`);
  if (!source.includes('const removeUnlinkedScrollListenerRef = React2.useRef(void 0);'))
    throw new Error(`Unexpected Radix ${version} scroll-area cleanup owner`);
  const originals = source.split(ORIGINAL).length - 1;
  const patched = source.split(PATCHED).length - 1;
  if (originals === 0 && patched === 1) return source;
  if (originals !== 1 || patched !== 0) {
    throw new Error(
      `Unexpected Radix ${version} scroll-area cleanup source; inspect the installed package before updating the patch`,
    );
  }
  return source.replace(ORIGINAL, PATCHED);
}
