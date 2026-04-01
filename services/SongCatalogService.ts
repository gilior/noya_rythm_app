import songs from "../assets/songs/output_smaple/samples.json";

type RawSong = (typeof songs)[number];

export interface CatalogSong {
  id: string;
  title: string;
  channel: string;
  genre: string;
  bpm: number | null;
  audioUrl: string | null;
}

export interface CatalogFilter {
  /** Restrict results to a single genre (e.g. `"lofi"`, `"ambient"`). When omitted, all genres are searched. */
  genre?: string;
  /** The desired BPM to match. Combined with `bpmTolerance` to form a search window of `[targetBpm - tolerance, targetBpm + tolerance]`. Ignored when both `minBpm` and `maxBpm` are provided. */
  targetBpm?: number;
  /** Half-width of the BPM search window around `targetBpm`. Defaults to `5`, so a `targetBpm` of 100 matches songs from 95–105 BPM. */
  bpmTolerance?: number;
  /** Explicit lower bound for BPM filtering. Overrides the `targetBpm - bpmTolerance` calculation when provided. */
  minBpm?: number;
  /** Explicit upper bound for BPM filtering. Overrides the `targetBpm + bpmTolerance` calculation when provided. */
  maxBpm?: number;
  /** Song IDs to exclude from the results (e.g. to avoid replaying recently heard tracks). */
  excludeIds?: Iterable<string>;
  /** Maximum number of songs to return. When omitted, all matching songs are returned. */
  limit?: number;
}

function normalizeBpm(value: RawSong["BPM"]): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSong(genre: string, song: RawSong): CatalogSong | null {
  if (!song.id) {
    return null;
  }

  return {
    id: song.id,
    title: song.title ?? song.id,
    channel: song.channel ?? "",
    genre,
    bpm: normalizeBpm(song.BPM),
    audioUrl: song.audio_url ?? null,
  };
}

function hasBpm(song: CatalogSong): song is CatalogSong & { bpm: number } {
  return song.bpm !== null;
}

function lowerBound(songs: readonly (CatalogSong & { bpm: number })[], bpm: number): number {
  let low = 0;
  let high = songs.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (songs[mid].bpm < bpm) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function createCatalog() {
  const allSongs: CatalogSong[] = [];
  const songsById = new Map<string, CatalogSong>();
  const songsByGenre = new Map<string, CatalogSong[]>();

  for (const rawSong of songs) {
    const song = normalizeSong(rawSong.genre, rawSong);
    if (!song) continue;

    allSongs.push(song);
    songsById.set(song.id, song);

    const genreSongs = songsByGenre.get(song.genre) ?? [];
    genreSongs.push(song);
    songsByGenre.set(song.genre, genreSongs);
  }

  const songsByGenreSortedByBpm = new Map<string, (CatalogSong & { bpm: number })[]>();

  for (const [genre, songs] of songsByGenre.entries()) {
    songsByGenreSortedByBpm.set(
      genre,
      songs.filter(hasBpm).sort((a, b) => a.bpm - b.bpm),
    );
  }

  const allSongsSortedByBpm = allSongs.filter(hasBpm).sort((a, b) => a.bpm - b.bpm);

  return {
    allSongs,
    allSongsSortedByBpm,
    songsByGenre,
    songsByGenreSortedByBpm,
    songsById,
  };
}

function sliceByBpm(songs: readonly (CatalogSong & { bpm: number })[], minBpm: number, maxBpm: number) {
  const start = lowerBound(songs, minBpm);
  const end = lowerBound(songs, maxBpm + Number.EPSILON);
  return songs.slice(start, end);
}

function applyExcludeAndLimit(songs: readonly CatalogSong[], excludeIds?: Iterable<string>, limit?: number) {
  const excluded = excludeIds ? new Set(excludeIds) : null;

  if (!excluded && limit === undefined) {
    return [...songs];
  }

  const result: CatalogSong[] = [];
  for (const song of songs) {
    if (excluded?.has(song.id)) {
      continue;
    }

    result.push(song);

    if (limit !== undefined && result.length >= limit) {
      break;
    }
  }

  return result;
}

class SongCatalogService {
  private readonly catalog = createCatalog();

  getGenres(): string[] {
    return [...this.catalog.songsByGenre.keys()];
  }

  getAllSongs(): CatalogSong[] {
    return [...this.catalog.allSongs];
  }

  getSongById(id: string): CatalogSong | null {
    return this.catalog.songsById.get(id) ?? null;
  }

  getSongsByGenre(genre: string): CatalogSong[] {
    return [...(this.catalog.songsByGenre.get(genre) ?? [])];
  }

  findSongs(filter: CatalogFilter = {}): CatalogSong[] {
    const { genre, targetBpm, bpmTolerance = 5, minBpm, maxBpm, excludeIds, limit } = filter;

    const bpmMin = minBpm ?? (targetBpm !== undefined ? targetBpm - bpmTolerance : undefined);
    const bpmMax = maxBpm ?? (targetBpm !== undefined ? targetBpm + bpmTolerance : undefined);

    if (bpmMin !== undefined && bpmMax !== undefined) {
      const songs = genre ? (this.catalog.songsByGenreSortedByBpm.get(genre) ?? []) : this.catalog.allSongsSortedByBpm;

      return applyExcludeAndLimit(sliceByBpm(songs, bpmMin, bpmMax), excludeIds, limit);
    }

    const songs = genre ? (this.catalog.songsByGenre.get(genre) ?? []) : this.catalog.allSongs;
    return applyExcludeAndLimit(songs, excludeIds, limit);
  }

  pickRandomSong(filter: CatalogFilter = {}): CatalogSong | null {
    const songs = this.findSongs(filter);
    if (songs.length === 0) {
      return null;
    }

    const index = Math.floor(Math.random() * songs.length);
    return songs[index];
  }
}

// Singleton shared across the app.
export const songCatalogService = new SongCatalogService();
