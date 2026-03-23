$ApiKey = "AIzaSyAhUYPxzpcNtcIm2Rq8RflFsG-TfUtlEVQ" 
$MaxPerGenre = 500
$OutputFolder = "lib"

if (-not (Test-Path $OutputFolder)) { New-Item -ItemType Directory -Path $OutputFolder }

# Define genres with multiple search variants to bypass the 500-result limit
$Genres = @(
    @{ id = "classical";  topicId = "/m/01mc8"; q = @("classical music", "mozart", "beethoven", "classical piano", "orchestra") },
    @{ id = "jazz";       topicId = "/m/03_d0"; q = @("jazz music", "cool jazz", "bebop", "blue note jazz", "smooth jazz") },
    @{ id = "nature";     topicId = "/m/05zppz"; q = @("nature sounds", "rain sounds", "forest sounds", "ocean waves sleep") },
    @{ id = "meditation"; topicId = "/m/01643"; q = @("meditation music", "zen music", "healing music", "chakra balancing") },
    @{ id = "lofi";       topicId = "/m/0glt67"; q = @("lofi hip hop", "lofi chill", "lofi beats", "chillhop") },
    @{ id = "downtempo";  topicId = "/m/02lkt"; q = @("downtempo music", "trip hop", "chillout music", "ambient house") },
    @{ id = "piano";      topicId = "/m/04rlf"; q = @("solo piano", "relaxing piano", "modern classical piano", "piano sleep") }
)

foreach ($Genre in $Genres) {
    Write-Host "`n--- Harvesting $($Genre.id) ---" -ForegroundColor Cyan
    $AllVideos = @()
    $VideoIds = New-Object System.Collections.Generic.HashSet[string]

    foreach ($SearchTerm in $Genre.q) {
        if ($VideoIds.Count -ge $MaxPerGenre) { break }
        
        Write-Host "  Trying Query: $SearchTerm..." -ForegroundColor Gray
        $NextPageToken = ""
        $PagesPerQuery = 0

        # Fetch up to 4 pages per sub-query to keep variety high
        while ($PagesPerQuery -lt 4 -and $VideoIds.Count -lt $MaxPerGenre) {
            $Uri = "https://www.googleapis.com/youtube/v3/search?part=snippet&q=$($SearchTerm) `"Provided to YouTube`" -live -concert -performance&topicId=$($Genre.topicId)&type=video&videoCategoryId=10&videoDefinition=high&maxResults=50&key=$ApiKey"
            if ($NextPageToken) { $Uri += "&pageToken=$NextPageToken" }

            try {
                $Response = Invoke-RestMethod -Uri $Uri -Method Get
                
                # Filter for Label Trust (Topic/VEVO)
                $OfficialTracks = $Response.items | Where-Object { 
                    $_.snippet.channelTitle -like "*- Topic" -or 
                    $_.snippet.channelTitle -like "*VEVO*" 
                }

                foreach ($item in $OfficialTracks) {
                    if ($VideoIds.Count -lt $MaxPerGenre -and $VideoIds.Add($item.id.videoId)) {
                        $AllVideos += [PSCustomObject]@{
                            id      = $item.id.videoId
                            title   = $item.snippet.title
                            channel = $item.snippet.channelTitle
                        }
                    }
                }

                $NextPageToken = $Response.nextPageToken
                $PagesPerQuery++
                if (-not $NextPageToken) { break }
            }
            catch {
                Write-Error "Error: $($_.Exception.Message)"
                break
            }
        }
        Write-Host "  Sub-total: $($VideoIds.Count)" -ForegroundColor Yellow
    }
    
    $GenreFile = Join-Path $OutputFolder "$($Genre.id).json"
    $AllVideos | ConvertTo-Json -Depth 10 | Set-Content $GenreFile
    Write-Host "✅ Saved $($AllVideos.Count) songs to $($Genre.id).json" -ForegroundColor Green
}

Write-Host "`n🎯 HARVEST COMPLETE! All files are in the /$OutputFolder folder." -ForegroundColor DarkGreen