export interface Genre {
  id: string;
  label: string;
  emoji: string;
}

export const GENRES: Genre[] = [
  { id: 'ambient', label: 'Ambient', emoji: '🌌' },
  { id: 'classical', label: 'Classical', emoji: '🎻' },
  { id: 'jazz', label: 'Jazz', emoji: '🎷' },
  { id: 'nature', label: 'Nature Sounds', emoji: '🌿' },
  { id: 'meditation', label: 'Meditation', emoji: '🧘' },
  { id: 'lofi', label: 'Lo-Fi', emoji: '🎧' },
  { id: 'downtempo', label: 'Downtempo', emoji: '🌙' },
  { id: 'piano', label: 'Solo Piano', emoji: '🎹' },
];
