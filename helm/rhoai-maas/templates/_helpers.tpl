{{/*
Full gateway hostname
*/}}
{{- define "rhoai-maas.gatewayHostname" -}}
{{ .Values.gateway.hostnamePrefix }}.{{ .Values.clusterDomain }}
{{- end }}

{{/*
Chart labels
*/}}
{{- define "rhoai-maas.labels" -}}
app.kubernetes.io/managed-by: Helm
app.kubernetes.io/part-of: rhoai-maas
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}
