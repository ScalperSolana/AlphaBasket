import { useState, useEffect } from 'react';

interface CountdownResult {
  expired: boolean;
  display: string;
  isUrgent: boolean;
  isCritical: boolean;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function useCountdown(endDate: string | undefined): CountdownResult | null {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!endDate) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endDate]);

  if (!endDate) return null;

  const diff = new Date(endDate).getTime() - now;
  if (diff <= 0) return { expired: true, display: 'Ended', isUrgent: false, isCritical: false, days: 0, hours: 0, minutes: 0, seconds: 0 };

  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);

  const isUrgent = diff < 3600000;
  const isCritical = diff < 300000;

  let display: string;
  if (days > 0) display = `${days}d ${hours}h`;
  else if (hours > 0) display = `${hours}h ${minutes}m`;
  else display = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return { expired: false, display, isUrgent, isCritical, days, hours, minutes, seconds };
}
