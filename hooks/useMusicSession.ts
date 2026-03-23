import { useEffect, useState } from 'react';
import { musicService, SessionState } from '../services/MusicService';

/** Subscribes to music session state changes */
export function useMusicSession(): SessionState {
  const [state, setState] = useState<SessionState>(musicService.getState());

  useEffect(() => {
    const unsub = musicService.onStateChange(setState);
    return unsub;
  }, []);

  return state;
}
