/**
 * STATE MACHINE: Benchmarks
 *
 * [MOUNTED] --> delegates to feature-layer implementation (BenchmarksView).
 * Lets the Rose Desktop Benchmarks panel load the view through the pages layer.
 */

export { BenchmarksView as default } from '@/features/benchmarks';
