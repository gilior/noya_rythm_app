$ApiKey = "AIzaSyAhUYPxzpcNtcIm2Rq8RflFsG-TfUtlEVQ" 
$MaxPerGenre = 500 # This will now mean "add up to 500 NEW songs per execution"
$OutputFolder = "lib"

if (-not (Test-Path $OutputFolder)) { New-Item -ItemType Directory -Path $OutputFolder }

# Define genres with multiple search variants to bypass the 500-result limit
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


foreach ($Genre in $Genres) {
    Write-Host "`n--- Harvesting $($Genre.id) ---" -ForegroundColor Cyan
    $GenreFile = Join-Path $OutputFolder "$($Genre.id).json"
    
    $AllVideos = @()
    $VideoIds = New-Object System.Collections.Generic.HashSet[string]

    # Load existing songs to append to them and prevent duplicates
    if (Test-Path $GenreFile) {
        try {
            $ExistingData = Get-Content $GenreFile -Raw | ConvertFrom-Json
            if ($null -ne $ExistingData) {
                # Ensure it's treated as an array
                $AllVideos += @($ExistingData)
                foreach ($item in $AllVideos) {
                    [void]$VideoIds.Add($item.id)
                }
                Write-Host "  Found $($AllVideos.Count) existing songs. Appending new ones..." -ForegroundColor Gray
            }
        } catch {
            Write-Warning "  Could not read existing file. Starting fresh."
        }
    }

    # Set our target count to the current count + 500 new songs
    $TargetCount = $VideoIds.Count + $MaxPerGenre

    foreach ($SearchTerm in $Genre.q) {
        if ($VideoIds.Count -ge $TargetCount) { break }
        
        # Pick a random 2-year window between 2008 and 2024 to randomize results across executions
        $StartYear = Get-Random -Minimum 2008 -Maximum 2024
        $EndYear = $StartYear + 2
        $PublishedAfter = "$StartYear-01-01T00:00:00Z"
        $PublishedBefore = "$EndYear-12-31T23:59:59Z"

        Write-Host "  Trying Query: $SearchTerm (Years $StartYear - $EndYear)..." -ForegroundColor Gray
        $NextPageToken = ""
        $PagesPerQuery = 0

        # Fetch up to 4 pages per sub-query to keep variety high
        while ($PagesPerQuery -lt 4 -and $VideoIds.Count -lt $TargetCount) {
            $Uri = "https://www.googleapis.com/youtube/v3/search?part=snippet&q=$($SearchTerm) `"Provided to YouTube`" -live -concert -performance&topicId=$($Genre.topicId)&type=video&videoCategoryId=10&videoDefinition=high&maxResults=50&publishedAfter=$PublishedAfter&publishedBefore=$PublishedBefore&key=$ApiKey"
            if ($NextPageToken) { $Uri += "&pageToken=$NextPageToken" }

            try {
                $Response = Invoke-RestMethod -Uri $Uri -Method Get
                
                # Filter for Label Trust (Topic/VEVO)
                $OfficialTracks = $Response.items | Where-Object { 
                    $_.snippet.channelTitle -like "*- Topic" -or 
                    $_.snippet.channelTitle -like "*VEVO*" 
                }

                foreach ($item in $OfficialTracks) {
                    # Only add if it doesn't already exist in our hashset from the loaded file
                    if ($VideoIds.Count -lt $TargetCount -and $VideoIds.Add($item.id.videoId)) {
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
    
    $AllVideos | ConvertTo-Json -Depth 10 | Set-Content $GenreFile
    Write-Host "✅ Saved $($AllVideos.Count) total songs to $($Genre.id).json" -ForegroundColor Green
}

Write-Host "`n🎯 HARVEST COMPLETE! All files are in the /$OutputFolder folder." -ForegroundColor DarkGreen