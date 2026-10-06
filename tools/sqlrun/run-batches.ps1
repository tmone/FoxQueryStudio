# Runs SQL batches on one connection and writes every result set as JSON.
# Used by tests to reach SQL Server LocalDB, which the Node driver (tedious) cannot open.
param(
  [Parameter(Mandatory)] [string] $Server,
  [Parameter(Mandatory)] [string] $Database,
  [Parameter(Mandatory)] [string] $InputFile,
  [Parameter(Mandatory)] [string] $OutputFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions

$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$serializer.MaxJsonLength = [int]::MaxValue
$batches = $serializer.DeserializeObject([IO.File]::ReadAllText($InputFile, [Text.Encoding]::UTF8))

$connection = New-Object System.Data.SqlClient.SqlConnection "Server=$Server;Database=$Database;Integrated Security=true;Connect Timeout=60"
$connection.Open()
# Collections are created with ::new(): New-Object wraps them in PSObject, which breaks the JSON serializer.
$results = [System.Collections.Generic.List[object]]::new()
try {
  foreach ($batch in $batches) {
    $resultSets = [System.Collections.Generic.List[object]]::new()
    $errorText = $null
    try {
      $command = $connection.CreateCommand()
      $command.CommandText = [string]$batch['sql']
      $command.CommandTimeout = 120
      $reader = $command.ExecuteReader()
      try {
        do {
          if ($reader.FieldCount -eq 0) { continue }
          $columns = [System.Collections.Generic.List[object]]::new()
          for ($i = 0; $i -lt $reader.FieldCount; $i++) { $columns.Add($reader.GetName($i)) }
          $rows = [System.Collections.Generic.List[object]]::new()
          while ($reader.Read()) {
            $row = [System.Collections.Generic.List[object]]::new()
            for ($i = 0; $i -lt $reader.FieldCount; $i++) {
              if ($reader.IsDBNull($i)) { $row.Add($null); continue }
              $value = $reader.GetValue($i)
              if ($value -is [DateTime]) { $row.Add($value.ToString('yyyy-MM-dd HH:mm:ss.fff')) }
              elseif ($value -is [byte[]]) { $row.Add('0x' + [BitConverter]::ToString($value).Replace('-', '')) }
              elseif ($value -is [decimal]) { $row.Add([double]$value) }
              else { $row.Add($value) }
            }
            $rows.Add($row)
          }
          $set = [System.Collections.Generic.Dictionary[string,object]]::new()
          $set['columns'] = $columns
          $set['rows'] = $rows
          $resultSets.Add($set)
        } while ($reader.NextResult())
      } finally {
        $reader.Close()
      }
    } catch {
      $errorText = [string]$_.Exception.GetBaseException().Message
    }
    $entry = [System.Collections.Generic.Dictionary[string,object]]::new()
    $entry['id'] = [string]$batch['id']
    $entry['resultSets'] = $resultSets
    $entry['error'] = $errorText
    $results.Add($entry)
  }
} finally {
  $connection.Close()
}

[IO.File]::WriteAllText($OutputFile, $serializer.Serialize($results), (New-Object Text.UTF8Encoding $false))
