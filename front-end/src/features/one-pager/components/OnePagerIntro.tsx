/**
 * STATE MACHINE: OnePagerIntro
 *
 * Stateless - renders introductory text about Rose Labs and Mass Agent Networks.
 *
 * [MOUNTED] --> renders static content
 */

export default function OnePagerIntro() {
  return (
    <section className="mb-14">
      <p className="text-xl leading-relaxed text-[#3d3a36] mb-6">
        Hi, we're{' '}
        <a
          href="https://linkedin.com/in/andyprevalsky"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 underline underline-offset-2 transition-colors"
        >
          Andy
        </a>{' '}
        and{' '}
        <a
          href="https://www.linkedin.com/in/aaditya-shidham/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 underline underline-offset-2 transition-colors"
        >
          Aaditya
        </a>
        , and we're building Rose Labs, a frontier AI research company in San Francisco.
      </p>
      <p className="text-xl leading-relaxed text-[#3d3a36]">
        Rose Labs is pioneering <strong>Mass Agent Networks (MANs)</strong> which we believe is the
        architecture that will produce the first real superintelligence.
      </p>
    </section>
  );
}
