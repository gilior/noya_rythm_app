# ─────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────
# Load .env file
$EnvFile = Join-Path $PSScriptRoot ".env"
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+?)\s*=\s*(.+)\s*$') {
        [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
    }
}

$ApiKey      = $env:YOUTUBE_API_KEY
$SupabaseUrl = $env:SUPABASE_URL
$SupabaseKey = $env:SUPABASE_SERVICE_ROLE_KEY
$MaxPerGenre  = 500   # max NEW songs to add per execution

# Supabase — replace with your project values

$SupabaseHeaders = @{
    "apikey"        = $SupabaseKey
    "Authorization" = "Bearer $SupabaseKey"
    "Content-Type"  = "application/json"
    "Prefer"        = "resolution=ignore-duplicates,return=minimal"
}

# ─────────────────────────────────────────────
#  GENRES
# ─────────────────────────────────────────────
$Genres = @(
    @{ id = "rock";       topicId = "/m/06by7"; q = @("rock music", "classic rock", "90s rock", "80s rock", "hard rock") },
    @{ id = "alt-rock";   topicId = "/m/06by7"; q = @("alternative rock", "indie rock", "90s alt rock", "grunge music") },
    @{ id = "ambient";    topicId = "/m/01643"; q = @("ambient music", "dark ambient", "space ambient", "ambient sleep") },
    @{ id = "classical";  topicId = "/m/01mc8"; q = @("classical music", "mozart", "beethoven", "classical piano", "orchestra") },
    @{ id = "jazz";       topicId = "/m/03_d0"; q = @("jazz music", "cool jazz", "bebop", "blue note jazz", "smooth jazz") },
    @{ id = "nature";     topicId = "/m/05zppz"; q = @("nature sounds", "rain sounds", "forest sounds", "ocean waves sleep") },
    @{ id = "meditation"; topicId = "/m/01643"; q = @("meditation music", "zen music", "healing music", "chakra balancing") },
    @{ id = "lofi";       topicId = "/m/0glt67"; q = @("lofi hip hop", "lofi chill", "lofi beats", "chillhop") },
    @{ id = "downtempo";  topicId = "/m/02lkt"; q = @("downtempo music", "trip hop", "chillout music", "ambient house") },
    @{ id = "piano";      topicId = "/m/04rlf"; q = @("solo piano", "relaxing piano", "modern classical piano", "piano sleep") }
)

# ─────────────────────────────────────────────
#  HELPER — upsert a single song row to Supabase
# ─────────────────────────────────────────────
function Push-SongToSupabase {
    param(
        [string]$Id,
        [string]$Title,
        [string]$Channel,
        [string]$Genre
    )
    $Body = [PSCustomObject]@{
        id      = $Id
        title   = $Title
        channel = $Channel
        genre   = $Genre
    } | ConvertTo-Json -Compress

    try {
        Invoke-RestMethod -Uri "$SupabaseUrl/rest/v1/songs" `
                          -Method Post `
                          -Headers $SupabaseHeaders `
                          -Body $Body | Out-Null
    }
    catch {
        Write-Warning "  Supabase insert failed for $Id`: $($_.Exception.Message)"
    }
}

# ─────────────────────────────────────────────
#  MAIN HARVEST LOOP
# ─────────────────────────────────────────────
$TotalInserted = 0

foreach ($Genre in $Genres) {
    Write-Host "`n--- Harvesting $($Genre.id) ---" -ForegroundColor Cyan

    $VideoIds    = New-Object System.Collections.Generic.HashSet[string]
    $TargetCount = $MaxPerGenre
    $GenreInserted = 0

    foreach ($SearchTerm in $Genre.q) {
        if ($VideoIds.Count -ge $TargetCount) { break }

        # Random 2-year window between 2008-2024 for variety across executions
        $StartYear      = Get-Random -Minimum 2008 -Maximum 2024
        $EndYear        = $StartYear + 2
        $PublishedAfter = "$StartYear-01-01T00:00:00Z"
        $PublishedBefore = "$EndYear-12-31T23:59:59Z"

        Write-Host "  Query: $SearchTerm ($StartYear-$EndYear)..." -ForegroundColor Gray

        $NextPageToken = ""
        $PagesPerQuery = 0

        while ($PagesPerQuery -lt 4 -and $VideoIds.Count -lt $TargetCount) {
            $Uri = "https://www.googleapis.com/youtube/v3/search" +
                   "?part=snippet" +
                   "&q=$([Uri]::EscapeDataString("$SearchTerm `"Provided to YouTube`" -live -concert -performance"))" +
                   "&topicId=$($Genre.topicId)" +
                   "&type=video&videoCategoryId=10&videoDefinition=high&maxResults=50" +
                   "&publishedAfter=$PublishedAfter&publishedBefore=$PublishedBefore" +
                   "&key=$ApiKey"
            if ($NextPageToken) { $Uri += "&pageToken=$NextPageToken" }

            try {
                $Response = Invoke-RestMethod -Uri $Uri -Method Get

                $OfficialTracks = $Response.items | Where-Object {
                    $_.snippet.channelTitle -like "*- Topic" -or
                    $_.snippet.channelTitle -like "*VEVO*"
                }

                foreach ($item in $OfficialTracks) {
                    if ($VideoIds.Count -lt $TargetCount -and $VideoIds.Add($item.id.videoId)) {
                        Push-SongToSupabase `
                            -Id      $item.id.videoId `
                            -Title   $item.snippet.title `
                            -Channel $item.snippet.channelTitle `
                            -Genre   $Genre.id
                        $GenreInserted++
                    }
                }

                $NextPageToken = $Response.nextPageToken
                $PagesPerQuery++
                if (-not $NextPageToken) { break }
            }
            catch {
                Write-Error "YouTube API error: $($_.Exception.Message)"
                break
            }
        }

        Write-Host "  Sub-total this genre: $($VideoIds.Count)" -ForegroundColor Yellow
    }

    $TotalInserted += $GenreInserted
    Write-Host "✅ $($Genre.id): $GenreInserted new rows pushed to Supabase" -ForegroundColor Green
}

Write-Host "`n🎯 HARVEST COMPLETE — $TotalInserted total rows inserted." -ForegroundColor DarkGreen
