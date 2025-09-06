{{- define "shop.name" -}}
{{- printf "srespace-%s" .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
