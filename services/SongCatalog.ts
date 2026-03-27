import altRockSongs from "../assets/songs/lib/alt-rock.json";
import ambientSongs from "../assets/songs/lib/ambient.json";
import classicalSongs from "../assets/songs/lib/classical.json";
import downtempoSongs from "../assets/songs/lib/downtempo.json";
import jazzSongs from "../assets/songs/lib/jazz.json";
import lofiSongs from "../assets/songs/lib/lofi.json";
import meditationSongs from "../assets/songs/lib/meditation.json";
import natureSongs from "../assets/songs/lib/nature.json";
import pianoSongs from "../assets/songs/lib/piano.json";
import rockSongs from "../assets/songs/lib/rock.json";

type RawSong = {
  id?: string;
  title?: string;
  channel?: string;
  BPM?: string | number | null;
  audio_url?: string | null;
};

export interface CatalogSong {
  id: string;
  title: string;
  channel: string;
  genre: string;
  bpm: number | null;
  audioUrl: string | null;
}

export interface CatalogFilter {
  genre?: string;
  targetBpm?: number;
  bpmTolerance?: number;
  minBpm?: number;
  maxBpm?: number;
  excludeIds?: Iterable<string>;
  limit?: number;
}

const RAW_LIBRARY: Record<string, RawSong[]> = {
  "alt-rock": altRockSongs,
  ambient: ambientSongs,
  classical: classicalSongs,
  downtempo: downtempoSongs,
  jazz: jazzSongs,
  lofi: lofiSongs,
  meditation: meditationSongs,
  nature: natureSongs,
  piano: pianoSongs,
  rock: rockSongs,
};

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

function lowerBound(songs: ReadonlyArray<CatalogSong & { bpm: number }>, bpm: number): number {
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

  for (const [genre, rawSongs] of Object.entries(RAW_LIBRARY)) {
    const normalizedSongs = rawSongs
      .map((song) => normalizeSong(genre, song))
      .filter((song): song is CatalogSong => song !== null);

    songsByGenre.set(genre, normalizedSongs);
    allSongs.push(...normalizedSongs);

    for (const song of normalizedSongs) {
      songsById.set(song.id, song);
    }
  }

  const songsByGenreSortedByBpm = new Map<
    string,
    Array<CatalogSong & { bpm: number }>
  >();

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

function sliceByBpm(
  songs: ReadonlyArray<CatalogSong & { bpm: number }>,
  minBpm: number,
  maxBpm: number,
) {
  const start = lowerBound(songs, minBpm);
  const end = lowerBound(songs, maxBpm + Number.EPSILON);
  return songs.slice(start, end);
}

function applyExcludeAndLimit(
  songs: ReadonlyArray<CatalogSong>,
  excludeIds?: Iterable<string>,
  limit?: number,
) {
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
    const {
      genre,
      targetBpm,
      bpmTolerance = 5,
      minBpm,
      maxBpm,
      excludeIds,
      limit,
    } = filter;

    const bpmMin = minBpm ?? (targetBpm !== undefined ? targetBpm - bpmTolerance : undefined);
    const bpmMax = maxBpm ?? (targetBpm !== undefined ? targetBpm + bpmTolerance : undefined);

    if (bpmMin !== undefined && bpmMax !== undefined) {
      const songs = genre
        ? (this.catalog.songsByGenreSortedByBpm.get(genre) ?? [])
        : this.catalog.allSongsSortedByBpm;

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
export const songCatalog = new SongCatalogService();
