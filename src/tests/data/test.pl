use strict;
use warnings;
use HTTP::Request;
use HTTP::Headers;
use LWP::UserAgent;
use JSON;
use experimental qw(smartmatch);
use Storable qw(dclone);
use File::Spec;
use Data::Dumper;

our $dbname;
our $dbpass;

require './dbconfig.pl';

my $a = 5;

my $b = 9595;

my $c = "Text Halllooooooooooo";

my %test;
my %grades;
$grades{"Foo Bar"}{'Mathematics'}         = 97;
$grades{"Foo Bar"}{'Literature'}          = 67;
$grades{"Bar Foo"}{'Literature'}          = 88;
$grades{"Bar Foo"}{'Mathematics'}         = 82;
$grades{"Bar Foo"}{'Art'}{'asdasdasdasd'} = 99;

# print Dumper (%grades) . "\n";

my %test2;

my @list  = ( 1,       2, "|VARSEP|", "v" );
my @list2 = ( 1,       2, 3, { "Test" => "Hallo" } );
my @list3 = ( "Hello", "World", 1, "false" );
my @list4;

# print "\n" . $a . "\n" . $b . "\n";

foreach (@ARGV) {
    # print "$_\n";
}

foreach ( sort keys %ENV ) {
    # print "$_ = $ENV{$_}\n";
}

my @dates = ("3 Nov, 1989", "Nov, 1989", "1 Jan, 1999");
# print "halo"

my $ua = LWP::UserAgent->new();
my $req = HTTP::Request->new( 'GET', 'https://jsonplaceholder.typicode.com/todos/1', HTTP::Headers->new('accept' => 'application/json') );
my $res = $ua->send_request($req);

sub unbless {
    my ($d) = @_;
    print $d;
}

unbless("Hallo Test\n");
unbless("Hallo Test\n\n");
unbless("Hallo Testasdasdasd");
unbless("Hallo \nTest");

my %item = (
    "id" => 1,
    "name"=> "Test"
);

$a = 'id';

print $item{$a} . "\n";

print Data::Dumper->new([$ua], [])->Deepcopy(1)->Sortkeys(1)->Indent(1)->Terse(0)->Trailingcomma(1)->Useqq(1)->Dump() . "\n";

print STDERR "Das ist ein Test \n\n" . $a . "\n" . Dumper({%item}) . "\n\n\nAHHHHHHHHHH\n\n";

print Dumper({ %item }) . "\n";
print $grades{'Bar Foo'}{'Art'}{'asdasdasdasd'};
print Dumper([ @list4 ]) . "\n";

print $list2[1] . "\n";