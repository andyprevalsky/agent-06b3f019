#!/usr/bin/env python3
"""
Complete animation processing pipeline:
original.mov → centered → trimmed → standardized → extracted frames (JSON)

Pipeline Steps:
1. Copy original.mov → animation-X.mov (working copy)
2. Center: Find dark dot and crop to center it
3. Trim: Remove dead time by detecting changes in center circle
4. Standardize: Resize all to same dimensions (222×222)
5. Extract: Read pixels with 5% edge crop (→200×200) and delta compress
"""

import subprocess
import sys
import shutil
from pathlib import Path

def run_script(script_name, description):
    """Run a Python script and check for errors."""
    print(f"\n{'='*60}")
    print(f"STEP: {description}")
    print(f"{'='*60}\n")
    
    script_path = Path(__file__).parent / script_name
    result = subprocess.run(
        [sys.executable, str(script_path)],
        capture_output=False
    )
    
    if result.returncode != 0:
        print(f"\n❌ Error in {script_name}")
        sys.exit(1)
    
    print(f"\n✅ {description} complete!\n")

def main():
    print("""
╔══════════════════════════════════════════════════════════╗
║     ANIMATION PROCESSING PIPELINE                        ║
║     original.mov → final JSON                            ║
╚══════════════════════════════════════════════════════════╝
""")
    
    # Step 0: Copy originals
    base_dir = Path(__file__).parent.parent / "video-to-process" / "fc" / "animations"
    print("\nSTEP 0: Copying original files...")
    for i in [1, 2, 3, 4]:
        original = base_dir / f"animation-{i}-original.mov"
        working = base_dir / f"animation-{i}.mov"
        if original.exists():
            shutil.copy2(original, working)
            print(f"  ✓ Copied animation-{i}-original.mov → animation-{i}.mov")
        else:
            print(f"  ⚠️  animation-{i}-original.mov not found")
    
    # Step 1: Center dots
    run_script("center-all-animations.py", "Step 1: Center Dots")
    
    # Step 2: Trim dead time  
    run_script("trim-animations-smart.py", "Step 2: Trim Dead Time")
    
    # Step 3: Standardize size
    run_script("standardize-size.py", "Step 3: Standardize Size to 222×222")
    
    # Step 4: Extract frames
    run_script("extract-all-animations.py", "Step 4: Extract Frames & Delta Compress")
    
    print("""
╔══════════════════════════════════════════════════════════╗
║     PIPELINE COMPLETE! ✅                                ║
╚══════════════════════════════════════════════════════════╝

Final outputs in src/lib/:
  - animation-1-pixels.json
  - animation-2-pixels.json
  - animation-3-pixels.json
  - animation-4-pixels.json

All animations are now:
  ✓ Dots centered at (111, 111)
  ✓ Dead time trimmed  
  ✓ Standardized to 200×200px (after 5% crop)
  ✓ Delta compressed
""")

if __name__ == "__main__":
    main()
