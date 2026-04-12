import { supabase } from "./supabase";

export interface CatalogSong {
  id: string;
  title: string;
  channel: string;
  genre: string;
  BPM: number | null;
  audio_url: string | null;
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

function hasBpm(song: CatalogSong): song is CatalogSong & { bpm: number } {
  return song.BPM !== null;
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

function createCatalog(songs: CatalogSong[]) {
  console.log(`[SongCatalogService] [createCatalog] songs input  ${songs.length}`);
  const allSongs: CatalogSong[] = [];
  const songsById = new Map<string, CatalogSong>();
  const songsByGenre = new Map<string, CatalogSong[]>();

  for (const song of songs) {
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
  private catalog!: ReturnType<typeof createCatalog>;
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

  // per given bpm, find the largest song bpm the close to the given bpm
  public findNearestLowBPMSong(genre: string, bpm: number, excludeIds: string[]): CatalogSong | null {
    // binary search to find closest bpm song to required bpm
    let res = null;
    const filterByGenre = this.catalog.songsByGenreSortedByBpm.get(genre) || [];
    if (filterByGenre?.length == 0) {
      // genre not exists -  fetch song based on bpm and unused song
      res = this.find_song(bpm, excludeIds, this.catalog.allSongsSortedByBpm);
      if (res == null) {
        // all songs are used just provide a song based on bpm
        res = this.find_song(bpm, [], this.catalog.allSongsSortedByBpm);
      }
    } else {
      // genre exists - find a song based on bpm and enre, just exclide used songs
      res = this.find_song(bpm, excludeIds, filterByGenre);
      if (res == null) {
        // all songs are used just provide a song based on bpm and genre
        res = this.find_song(bpm, [], filterByGenre);
      }
    }
    return res;
  }

  private find_song(bpm: number, excludeIds: string[], songs: (CatalogSong & { bpm: number })[]): CatalogSong | null {
    let index_of_bpm = lowerBound(songs, bpm) - 1;
    let start_from = index_of_bpm < 0 ? 0 : Math.min(index_of_bpm, songs.length - 1);
    // now index_of_bpm is the relevant bpm or the closest
    // scan down to find the nearest song with bpm lower but keep an eye on excluded
    for (let i = start_from; i > -1; i--) {
      const curr_song = songs[i];
      if (!excludeIds.includes(curr_song.id)) {
        return curr_song;
      }
    }
    return null;
  }

  async initialize(): Promise<void> {
    const PAGE_SIZE = 1000;
    const allRows: any[] = [];
    let from = 0;

    while (true) {
      const { data, error } = await supabase
        .from("songs")
        .select()
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        console.error("[SongCatalogService] Failed to load catalog:", error.message);
        throw new Error(`Failed to load catalog: ${error.message}`);
      }

      allRows.push(...data);

      if (data.length < PAGE_SIZE) break; // last page
      from += PAGE_SIZE;
    }

    const songs: CatalogSong[] = (allRows ?? []).map((row) => ({
      id: row.id,
      title: row.title ?? row.id,
      channel: row.channel ?? "",
      genre: row.genre,
      BPM: row.BPM ?? null, // uppercase BPM
      audio_url: row.audio_url ?? null, // snake_case → camelCase
    }));

    this.catalog = createCatalog(songs);
    console.log(
      `[SongCatalogService] Catalog initialized: ${songs.length} total songs, ` +
        `${this.catalog.songsByGenre.size} genres (${[...this.catalog.songsByGenre.keys()].join(", ")}), ` +
        `${this.catalog.allSongsSortedByBpm.length} songs with BPM data.`,
    );
  }
}

// Singleton shared across the app.
export const songCatalogService = new SongCatalogService();
