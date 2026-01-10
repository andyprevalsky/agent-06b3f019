/**
 * STATE MACHINE: FloatingParticles
 *
 * [INIT] --> particles: [] (empty)
 *   |
 *   v (useEffect on mount)
 * [READY] --> particles: Array<{id, left, delay}>
 *   |
 *   +--> CSS animations handle particle movement
 */

import { useEffect, useState } from "react";

const FloatingParticles = () => {
  const [particles, setParticles] = useState<Array<{ id: number; left: number; delay: number }>>([]);

  useEffect(() => {
    const newParticles = Array.from({ length: 15 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 20,
    }));
    setParticles(newParticles);
  }, []);

  return (
    <div className="floating-particles">
      {particles.map((particle) => (
        <div
          key={particle.id}
          className="particle"
          style={{
            left: `${particle.left}%`,
            animationDelay: `${particle.delay}s`,
          }}
        />
      ))}
    </div>
  );
};

export default FloatingParticles;